// Private loopback/process boundary integration test.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import { afterEach, describe, expect, it } from "vitest";
import { openPiSupervisorBridge } from "../src/boundary/pi-supervisor-bridge-client.ts";
import type { SupervisorMcpToolArgumentsByName as SupervisorToolArgumentsByName } from "../src/supervisor/mcp-contract.ts";
import { makeSupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../src/run/limits.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;

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

// Real-time polling of live child processes deliberately runs on the live default clock.
const waitForDead = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200 && processAlive(pid); attempt += 1)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe("packaged delegated-Pi supervisor bridge", () => {
  for (const mode of ["malformed", "timeout", "notification-close"] as const) {
    it(`centralizes ${mode} pre-open cleanup and kills the helper`, () =>
      fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-open-")).then((directory) => {
        directories.push(directory);
        const scenario = join(directory, "scenario.json");
        return fs
          .writeFile(scenario, JSON.stringify({ mode }))
          .then(() =>
            Effect.runPromise(
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
            ),
          )
          .then(() =>
            fs
              .readFile(`${scenario}.pid`, "utf8")
              .then((value) => Number(value))
              .catch(() => undefined),
          )
          .then((pid) => {
            if (pid === undefined) return;
            return waitForDead(pid).then(() => {
              expect(processAlive(pid)).toBe(false);
            });
          });
      }));
  }

  it("kills a successfully initialized helper when its scope closes", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-scope-")).then((directory) => {
      directories.push(directory);
      const scenario = join(directory, "scenario.json");
      return fs
        .writeFile(scenario, JSON.stringify({ mode: "open" }))
        .then(() =>
          Effect.runPromise(
            Effect.scoped(
              openPiSupervisorBridge(scenario, {
                helperPath: openFixture,
                initializeTimeoutMillis: 1_000,
              }),
            ),
          ),
        )
        .then(() => fs.readFile(`${scenario}.pid`, "utf8"))
        .then((value) => Number(value))
        .then((pid) =>
          waitForDead(pid).then(() => {
            expect(processAlive(pid)).toBe(false);
          }),
        );
    }));

  it("supports concurrent progress, exact question/reply, and report delivery", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-")).then((directory) => {
      directories.push(directory);
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
              runId: "agent-pi-bridge",
            });
            const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
            yield* channel.awaitReady;
            yield* channel.setAssignmentEpoch(1);

            const question = yield* client
              .call("supervisor_question", { message: "Which branch?" })
              .pipe(Effect.forkScoped);
            const progress = yield* client
              .call("supervisor_progress", { message: "Inspecting branches" })
              .pipe(Effect.forkScoped);

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

            const reportCall = yield* client
              .call("supervisor_submit_report", {
                delivery_id: "generation-1",
                report: "Complete report",
              })
              .pipe(Effect.forkScoped);
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
    }));

  it("delivers root-pushed descendant outcomes to delegated Pi", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-notification-")).then((directory) => {
      directories.push(directory);
      const notifications: string[] = [];
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
              runId: "agent-pi-notification",
              allowPiProxy: true,
            });
            yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath, {
              onNotification: (message) => notifications.push(message),
            });
            yield* channel.awaitReady;
            yield* channel.setAssignmentEpoch(1);
            yield* channel.deliverNotification("Descendant report ready.");
            expect(notifications).toEqual(["Descendant report ready."]);
          }),
        ),
      );
    }));

  it("preserves the maximum parent reply through the MCP bridge envelope", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-max-reply-")).then((directory) => {
      directories.push(directory);
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
              runId: "agent-pi-max-reply",
            });
            const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
            yield* channel.awaitReady;
            yield* channel.setAssignmentEpoch(1);

            const question = yield* client
              .call("supervisor_question", { message: "Return the maximum reply" })
              .pipe(Effect.forkScoped);
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
    }));

  it("propagates question cancellation without failing the bridge session", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-cancel-")).then((directory) => {
      directories.push(directory);
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
              runId: "agent-pi-cancel",
            });
            const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
            yield* channel.awaitReady;
            yield* channel.setAssignmentEpoch(1);

            const question = yield* client
              .call("supervisor_question", { message: "Cancel this exact question" })
              .pipe(Effect.forkScoped);
            const questionEvent = yield* Queue.take(channel.events);
            expect(questionEvent).toMatchObject({
              type: "supervisor_contact",
              kind: "question",
              assignmentEpoch: 1,
            });
            yield* Fiber.interrupt(question);
            expect(yield* Queue.take(channel.events)).toMatchObject({
              type: "supervisor_question_cancelled",
              assignmentEpoch: 1,
            });

            expect(
              yield* client.call("supervisor_progress", { message: "Bridge remains live" }),
            ).toContain("Progress delivered");
            expect(yield* Queue.take(channel.events)).toMatchObject({
              type: "supervisor_contact",
              kind: "progress",
              message: "Bridge remains live",
            });
          }),
        ),
      );
    }));

  it("strictly rejects malformed bridge tool input", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-pi-bridge-invalid-")).then((directory) => {
      directories.push(directory);
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
              runId: "agent-pi-invalid",
            });
            const client = yield* openPiSupervisorBridge(channel.metadata.connectionConfigPath);
            yield* channel.awaitReady;
            yield* channel.setAssignmentEpoch(1);
            // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
            const callHostileInput = client.call as (
              name: "supervisor_progress",
              input: SupervisorToolArgumentsByName["supervisor_progress"] & {
                readonly extra: boolean;
              },
            ) => ReturnType<typeof client.call>;
            const error = yield* callHostileInput("supervisor_progress", {
              message: "ok",
              extra: true,
            }).pipe(Effect.flip);
            expect(error).toBeInstanceOf(Error);
          }),
        ),
      );
    }));
});
