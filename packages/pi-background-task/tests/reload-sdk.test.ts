import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { signalProcessGroup } from "pi-cosmic-core";
import { nodeFilePlatformLayer } from "pi-cosmic-core/platform/node-file";
import { pollUntil, step } from "pi-cosmic-core/testing";
import {
  fauxAssistantMessage,
  fauxModels,
  fauxToolCall,
  quietLoader,
  quietSettings,
} from "pi-cosmic-core/testing/sdk";
import { afterEach, vi } from "vitest";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";
import { decodeDetails } from "./support/application-host.ts";

afterEach(() => vi.unstubAllEnvs());

it.live("keeps the process and incremental output across a real Pi reload, but not quit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "background-task-sdk-reload-" });
    vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
    // Notices still reach the transcript in a subagent session, without starting inference.
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const { fake, models } = yield* fauxModels("background-task-reload-test");
    const settingsManager = quietSettings();
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendMessage(
      fauxAssistantMessage(fauxToolCall("probe", {}, { id: "parent-call" }), {
        stopReason: "toolUse",
        timestamp: 0,
      }),
    );
    const entrypoint = fileURLToPath(new URL("../src/extension.ts", import.meta.url));
    const source = path.join(cwd, "reload-fixture.ts");
    const writeExtension = (version: "before" | "after") =>
      fs.writeFileString(
        source,
        `
        import register from ${JSON.stringify(entrypoint)};
        export default (pi) => {
          register(pi);
          pi.registerCommand("reload-fixture-${version}", { handler: () => {} });
        };
      `,
      );
    yield* writeExtension("before");
    const resourceLoader = yield* quietLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: [source],
    });
    const emergencyCleanup = new Set<number>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of emergencyCleanup) signalProcessGroup(pid, "SIGKILL");
      }),
    );
    const closedPid = yield* Effect.scoped(
      Effect.gen(function* () {
        const { session } = yield* Effect.acquireRelease(
          step(() =>
            createAgentSession({
              cwd,
              agentDir: cwd,
              model: fake.getModel(),
              modelRuntime: models,
              settingsManager,
              resourceLoader,
              sessionManager,
            }),
          ),
          ({ session: owned }) =>
            step(() => owned.abort()).pipe(
              Effect.andThen(
                step(() =>
                  owned.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
                ),
              ),
              Effect.ensuring(Effect.sync(() => owned.dispose())),
            ),
        );
        const onError = vi.fn();
        yield* step(() => session.bindExtensions({ mode: "print", onError }));
        const execute = (args: BackgroundTaskToolInput) =>
          step(() =>
            session.extensionRunner
              .createToolContext("parent-call", undefined)
              .executeTool("background_task", args),
          );
        const start = yield* execute({
          action: "start",
          command:
            "echo BEFORE_RELOAD; while [ ! -f reload-gate ]; do sleep 0.05; done; echo AFTER_RELOAD; exec sleep 120",
        });
        expect(start.isError).toBe(false);
        const started = decodeDetails(start.result.details);
        if (started.action !== "start" || started.snapshot.pid === undefined)
          throw new Error("Background process didn't start");
        const { id, pid } = started.snapshot;
        emergencyCleanup.add(pid);
        const initial = yield* execute({ action: "logs", id, afterCursor: 0, waitSeconds: 5 });
        const before = decodeDetails(initial.result.details);
        if (before.action !== "logs") throw new Error("No initial logs");
        expect(before.logs.nextCursor).toBeGreaterThan(0);
        const initialText = initial.result.content[0];
        expect(initialText?.type === "text" ? initialText.text : "").toContain("BEFORE_RELOAD");

        const finishing = yield* execute({
          action: "start",
          name: "finish-across-reload",
          command: "while [ ! -f finish-gate ]; do sleep 0.05; done; exit 0",
          notify: "exit",
        });
        const finishStart = decodeDetails(finishing.result.details);
        if (finishStart.action !== "start" || finishStart.snapshot.pid === undefined)
          throw new Error("Notifying process didn't start");
        const finishingPid = finishStart.snapshot.pid;
        emergencyCleanup.add(finishingPid);
        const notices = () =>
          Arr.filter(
            sessionManager.getBranch(),
            (entry) =>
              entry.type === "custom_message" && entry.customType === "pi-background-task-finished",
          );
        const finishInGap = fs.writeFileString(path.join(cwd, "finish-gate"), "").pipe(
          Effect.andThen(pollUntil(() => signalProcessGroup(finishingPid, 0) === "absent", 1_000)),
          Effect.tap((gone) =>
            Effect.sync(() => {
              expect(gone).toBe(true);
              emergencyCleanup.delete(finishingPid);
              expect(notices()).toHaveLength(0);
            }),
          ),
          Effect.asVoid,
        );
        expect(session.extensionRunner.getCommand("reload-fixture-before")).toBeDefined();
        yield* writeExtension("after");
        const configDir = path.join(cwd, "extensions");
        yield* fs.makeDirectory(configDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(configDir, "pi-background-task.json"),
          '{"enabled":false}',
        );
        const runInGap = Effect.runPromiseWith(yield* Effect.context());
        yield* step(() => session.reload({ beforeSessionStart: () => runInGap(finishInGap) }));
        expect(yield* pollUntil(() => notices().length > 0, 1_000)).toBe(true);
        yield* step(() => session.reload());
        expect(notices()).toHaveLength(1);
        expect(session.extensionRunner.getCommand("reload-fixture-before")).toBeUndefined();
        expect(session.extensionRunner.getCommand("reload-fixture-after")).toBeDefined();
        const status = decodeDetails((yield* execute({ action: "status", id })).result.details);
        expect(status).toMatchObject({ action: "status", snapshot: { id, pid, state: "running" } });
        const denied = yield* execute({ action: "start", command: ":" });
        expect(denied.isError).toBe(true);

        yield* fs.writeFileString(path.join(cwd, "reload-gate"), "");
        const incremental = yield* execute({
          action: "logs",
          id,
          afterCursor: before.logs.nextCursor,
          waitSeconds: 5,
        });
        const after = decodeDetails(incremental.result.details);
        if (after.action !== "logs") throw new Error("No subsequent logs");
        expect(after.logs.nextCursor).toBeGreaterThan(before.logs.nextCursor);
        const more = incremental.result.content[0];
        const text = more?.type === "text" ? more.text : "";
        expect(text).toContain("AFTER_RELOAD");
        expect(text).not.toContain("BEFORE_RELOAD");
        expect(signalProcessGroup(pid, 0)).toBe("present");
        expect(onError).not.toHaveBeenCalled();
        return pid;
      }),
    );
    expect(yield* pollUntil(() => signalProcessGroup(closedPid, 0) === "absent", 1_000)).toBe(true);
    emergencyCleanup.delete(closedPid);
  }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
