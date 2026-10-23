import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { signalProcessGroup } from "pi-cosmic-core";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { childToolPolicy, ChildProcess } from "../src/boundary/child-process.ts";
import { childSystemPrompt } from "../src/run/tool-policy.ts";
import { PROJECT_PROBE_TOOL } from "./fixtures/project-probe-extension.ts";
import {
  SCRIPT,
  SCRIPTED_MODEL,
  SCRIPTED_OBSERVATIONS_FILE,
  ScriptedObservation,
} from "./fixtures/scripted-pi-provider.ts";
import {
  awaitRuns,
  request,
  runView,
  serviceLayer,
  withService,
} from "./run/fixtures/service-harness.ts";
import { nodeFsPromises as fs, nodePath as path } from "./support/node-builtins.ts";
import { processAlive } from "./support/process-liveness.ts";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const reexport = (target: string) => `export { default } from ${JSON.stringify(target)};\n`;
const decodeObservation = Schema.decodeUnknownSync(Schema.fromJsonString(ScriptedObservation));

// Children inherit the root process environment, so the test points them at a private home and
// agent directory until its scope closes.
const isolatedEnvironment = (home: string, agentDirectory: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv("HOME", home);
      vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
      vi.stubEnv("PI_OFFLINE", "1");
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );

const scriptedPiHome = Effect.gen(function* () {
  const home = yield* temporaryDirectory("pi-subagents-real-child-").pipe(
    Effect.flatMap((directory) => Effect.promise(() => fs.realpath(directory))),
  );
  const agentDirectory = path.join(home, "agent");
  const cwd = path.join(home, "project");
  const extensions = [
    [path.join(agentDirectory, "extensions"), "scripted-pi-provider.ts"],
    [path.join(cwd, ".pi", "extensions"), "project-probe-extension.ts"],
  ] as const;
  for (const [directory, name] of extensions) {
    yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }));
    yield* Effect.promise(() => fs.writeFile(path.join(directory, name), reexport(fixture(name))));
  }
  yield* isolatedEnvironment(home, agentDirectory);
  return { agentDirectory, cwd };
});

const readObservations = (agentDirectory: string) =>
  Effect.promise(() =>
    fs.readFile(path.join(agentDirectory, SCRIPTED_OBSERVATIONS_FILE), "utf8"),
  ).pipe(
    Effect.map((text) =>
      Arr.map(Str.split(Str.trim(text), "\n"), (line) => decodeObservation(line)),
    ),
  );

// A terminal run state does not prove its process has exited; cleanup finishes asynchronously.
const exited = (pid: number | undefined) =>
  Effect.suspend(() =>
    pid !== undefined && !processAlive(pid) ? Effect.succeed(true) : Effect.fail("alive"),
  ).pipe(
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
  );

describe("installed Pi child through the local launch path", () => {
  it.live(
    "contacts, reports, resumes from its session file, and stops with its subtree",
    () =>
      Effect.gen(function* () {
        const { agentDirectory, cwd } = yield* scriptedPiHome;
        const pids = new Set<number>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of pids) signalProcessGroup(pid, "SIGKILL");
          }),
        );
        const layer = serviceLayer({
          publish: (projection) => {
            for (const run of projection.runs) if (run.pid !== undefined) pids.add(run.pid);
          },
        }).pipe(Layer.provide(ChildProcess.layer({ agentDirectory })));
        const activeTools = ["read", "bash", "edit", "write", PROJECT_PROBE_TOOL];
        const scripted = (name: string, task: string, parentRunId?: string) =>
          request({
            name,
            task,
            cwd,
            model: SCRIPTED_MODEL,
            activeTools,
            projectTrusted: true,
            parentRunId,
          });

        yield* withService(layer, function* (service) {
          const first = scripted("scripted-child", SCRIPT.progressTask);
          const started = yield* service.start(first);
          const [completed] = yield* awaitRuns(service, [started.id]);
          expect(completed).toMatchObject({
            state: "completed",
            model: SCRIPTED_MODEL,
            effort: "high",
            finalText: SCRIPT.report,
          });
          expect(completed?.sessionEvents).toContainEqual(
            expect.objectContaining({
              type: "notice",
              kind: "progress",
              text: SCRIPT.progressMessage,
            }),
          );
          const assignment = Option.getOrUndefined(
            Arr.findFirst(yield* readObservations(agentDirectory), (observation) =>
              Fn.pipe(observation.prompt, Str.includes(SCRIPT.progressTask)),
            ),
          );
          expect(assignment?.systemPrompt).toContain(childSystemPrompt(first));
          assert(assignment !== undefined);
          expect(Arr.sort(assignment.tools, Order.String)).toEqual(
            Arr.sort(childToolPolicy(activeTools).enabled, Order.String),
          );
          expect(yield* exited(started.pid)).toBe(true);

          const sessionFile = completed?.sessionFile ?? "";
          expect(Fn.pipe(sessionFile, Str.startsWith(path.join(agentDirectory, "subagents")))).toBe(
            true,
          );
          expect(SessionManager.open(sessionFile).getSessionName()).toBe("scripted-child");
          yield* service.resume(started.id, SCRIPT.resumeTask);
          const [resumed] = yield* awaitRuns(service, [started.id]);
          expect(resumed).toMatchObject({
            state: "completed",
            finalText: SCRIPT.resumedWithHistory,
            sessionFile,
          });

          const parent = yield* service.start(scripted("scripted-parent", SCRIPT.holdTask));
          const descendant = yield* service.start(
            scripted("scripted-descendant", SCRIPT.holdTask, parent.id),
          );
          const running = [
            yield* runView(service, parent.id),
            yield* runView(service, descendant.id),
          ];
          expect(Arr.map(running, (run) => run.state)).toEqual(["running", "running"]);
          yield* service.stop(parent.id);
          expect((yield* runView(service, parent.id)).state).toBe("stopped");
          expect((yield* runView(service, descendant.id)).state).toBe("stopped");
          for (const run of running) expect(yield* exited(run.pid)).toBe(true);
        });
      }).pipe(Effect.timeout("45 seconds"), Effect.scoped),
    60_000,
  );
});
