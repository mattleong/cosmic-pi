// Private loopback/process boundary integration test.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { afterEach, describe, expect, it } from "vitest";
import {
  openPiSupervisorBridge,
  type SupervisorToolArgumentsByName,
} from "../src/boundary/pi-supervisor-bridge-client.ts";
import { makeSupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../src/run/limits.ts";

const directories: string[] = [];
const openFixture = fileURLToPath(
  new URL("./fixtures/pi-bridge-open-fixture.mjs", import.meta.url),
);

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForDead = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 200 && processAlive(pid); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("packaged delegated-Pi supervisor bridge", () => {
  for (const mode of ["malformed", "timeout", "notification-close"] as const) {
    it(`centralizes ${mode} pre-open cleanup and kills the helper`, async () => {
      const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-open-"));
      directories.push(directory);
      const scenario = join(directory, "scenario.json");
      await fs.writeFile(scenario, JSON.stringify({ mode }));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* Effect.exit(
              openPiSupervisorBridge(scenario, {
                helperPath: openFixture,
                initializeTimeoutMillis: 75,
              }),
            );
            expect(Exit.isFailure(opened)).toBe(true);
          }),
        ),
      );
      const pid = await fs
        .readFile(`${scenario}.pid`, "utf8")
        .then((value) => Number(value))
        .catch(() => undefined);
      if (pid !== undefined) {
        await waitForDead(pid);
        expect(processAlive(pid)).toBe(false);
      }
    });
  }

  it("supports concurrent progress, exact question/reply, and report delivery", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-"));
    directories.push(directory);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
            runId: "agent-pi-bridge",
          });
          const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          yield* channel.awaitReady;
          yield* channel.setAssignmentEpoch(1);

          const question = yield* Effect.tryPromise(() =>
            client.call("supervisor_question", { message: "Which branch?" }),
          ).pipe(Effect.forkScoped);
          const progress = yield* Effect.tryPromise(() =>
            client.call("supervisor_progress", { message: "Inspecting branches" }),
          ).pipe(Effect.forkScoped);

          const first = yield* Queue.take(channel.events);
          const second = yield* Queue.take(channel.events);
          const contacts = [first, second].filter((event) => event.type === "supervisor_contact");
          expect(contacts).toHaveLength(2);
          const questionEvent = contacts.find(
            (event) => event.type === "supervisor_contact" && event.kind === "question",
          );
          expect(questionEvent).toMatchObject({
            type: "supervisor_contact",
            assignmentEpoch: 1,
            message: "Which branch?",
          });
          if (!questionEvent || questionEvent.type !== "supervisor_contact")
            throw new Error("missing question");
          yield* channel.reply(questionEvent.requestId, "main");
          expect(yield* Fiber.join(question)).toContain("Parent reply: main");
          expect(yield* Fiber.join(progress)).toContain("Progress delivered");

          const reportCall = yield* Effect.tryPromise(() =>
            client.call("supervisor_submit_report", {
              delivery_id: "generation-1",
              report: "Complete report",
            }),
          ).pipe(Effect.forkScoped);
          const report = yield* Queue.take(channel.events);
          expect(report).toMatchObject({
            type: "report",
            runId: "agent-pi-bridge",
            assignmentEpoch: 1,
            sequence: 1,
            deliveryId: "generation-1",
            text: "Complete report",
          });
          expect(yield* Fiber.join(reportCall)).toContain("Final report accepted");
        }),
      ),
    );
  });

  it("preserves the maximum parent reply through the MCP bridge envelope", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-max-reply-"));
    directories.push(directory);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
            runId: "agent-pi-max-reply",
          });
          const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          yield* channel.awaitReady;
          yield* channel.setAssignmentEpoch(1);

          const question = yield* Effect.tryPromise(() =>
            client.call("supervisor_question", { message: "Return the maximum reply" }),
          ).pipe(Effect.forkScoped);
          const questionEvent = yield* Queue.take(channel.events);
          if (questionEvent.type !== "supervisor_contact")
            return yield* Effect.die("missing maximum-reply question");
          const reply = "x".repeat(MAX_PARENT_MESSAGE_CHARS);
          yield* channel.reply(questionEvent.requestId, reply);
          const delivered = yield* Fiber.join(question);
          expect(delivered).toBe(`Parent reply: ${reply}`);
        }),
      ),
    );
  });

  it("propagates question cancellation without failing the bridge session", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-cancel-"));
    directories.push(directory);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
            runId: "agent-pi-cancel",
          });
          const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          yield* channel.awaitReady;
          yield* channel.setAssignmentEpoch(1);

          const controller = new AbortController();
          const question = client.call(
            "supervisor_question",
            { message: "Cancel this exact question" },
            controller.signal,
          );
          const questionEvent = yield* Queue.take(channel.events);
          expect(questionEvent).toMatchObject({
            type: "supervisor_contact",
            kind: "question",
            assignmentEpoch: 1,
          });
          controller.abort();
          yield* Effect.tryPromise(() => question).pipe(Effect.flip);
          expect(yield* Queue.take(channel.events)).toMatchObject({
            type: "supervisor_question_cancelled",
            assignmentEpoch: 1,
          });

          expect(
            yield* Effect.tryPromise(() =>
              client.call("supervisor_progress", { message: "Bridge remains live" }),
            ),
          ).toContain("Progress delivered");
          expect(yield* Queue.take(channel.events)).toMatchObject({
            type: "supervisor_contact",
            kind: "progress",
            message: "Bridge remains live",
          });
        }),
      ),
    );
  });

  it("strictly rejects malformed bridge tool input", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-invalid-"));
    directories.push(directory);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
            runId: "agent-pi-invalid",
          });
          const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
          yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
          yield* channel.awaitReady;
          yield* channel.setAssignmentEpoch(1);
          // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
          const callHostileInput = client.call as (
            name: "supervisor_progress",
            input: SupervisorToolArgumentsByName["supervisor_progress"] & {
              readonly extra: boolean;
            },
          ) => Promise<string>;
          const error = yield* Effect.tryPromise(() =>
            callHostileInput("supervisor_progress", { message: "ok", extra: true }),
          ).pipe(Effect.flip);
          expect(error).toBeInstanceOf(Error);
        }),
      ),
    );
  });
});
