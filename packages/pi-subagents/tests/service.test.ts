// Explicit test entry-point Layer provision owns each scoped service runtime.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type { ParentReply, PeerNotice, RpcCommand } from "../src/run/protocol.ts";
import {
  ChildProcess,
  type ChildProcessHandle,
  type ChildWireEvent,
} from "../src/boundary/child-process.ts";
import type { StartSubagentRequest, SubagentProjection } from "../src/run/model.ts";
import { SubagentService } from "../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";

interface FakeChildControl {
  readonly commands: RpcCommand[];
  readonly ipc: Array<ParentReply | PeerNotice>;
  readonly terminations: Array<"graceful" | "force">;
  readonly failNext: (type: RpcCommand["type"], error: string) => void;
  readonly offer: (value: unknown) => void;
}

function fakeChildLayer() {
  const controls: FakeChildControl[] = [];
  const layer = Layer.succeed(ChildProcess, {
    spawn: () =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
          const commands: RpcCommand[] = [];
          const ipc: Array<ParentReply | PeerNotice> = [];
          const terminations: Array<"graceful" | "force"> = [];
          const failures: Array<{ readonly type: RpcCommand["type"]; readonly error: string }> = [];
          const failNext = (type: RpcCommand["type"], error: string) => {
            failures.push({ type, error });
          };
          const offer = (value: unknown) => Queue.offerUnsafe(events, { type: "message", value });
          const handle: ChildProcessHandle = {
            pid: 10_000 + controls.length,
            events,
            awaitExit: Effect.never,
            send: (command) =>
              Effect.sync(() => {
                commands.push(command);
                const failureIndex = failures.findIndex((failure) => failure.type === command.type);
                const failure = failureIndex >= 0 ? failures.splice(failureIndex, 1)[0] : undefined;
                offer(
                  failure
                    ? {
                        type: "response",
                        id: command.id,
                        command: command.type,
                        success: false,
                        error: failure.error,
                      }
                    : {
                        type: "response",
                        id: command.id,
                        command: command.type,
                        success: true,
                        data:
                          command.type === "get_state"
                            ? {
                                sessionId: "child-session",
                                sessionFile: "/tmp/child-session.jsonl",
                                thinkingLevel: "high",
                              }
                            : undefined,
                      },
                );
              }),
            sendIpc: (message) => Effect.sync(() => void ipc.push(message)),
            terminate: (mode) => Effect.sync(() => void terminations.push(mode)),
          };
          controls.push({ commands, ipc, terminations, failNext, offer });
          return { handle, events };
        }),
        ({ events }) => Effect.sync(() => Queue.endUnsafe(events)),
      ).pipe(Effect.map(({ handle }) => handle)),
  });
  return { controls, layer };
}

const request = (overrides: Partial<StartSubagentRequest> = {}): StartSubagentRequest => ({
  task: "Inspect authentication",
  cwd: "/project",
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  effortWasExplicit: true,
  activeTools: ["read", "bash", "edit", "write"],
  projectTrusted: true,
  parentSessionId: "parent-session",
  parentSessionFile: "/tmp/parent.jsonl",
  parentLeafId: "parent-leaf",
  ...overrides,
});

describe("SubagentService", () => {
  it.effect("starts a child, projects completion, and retains bounded result state", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = SubagentService.layer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const started = yield* service.start(request({ name: "auth-reader" }));
      expect(started).toMatchObject({
        id: "agent-1",
        name: "auth-reader",
        state: "running",
        sessionFile: "/tmp/child-session.jsonl",
      });
      expect(fake.controls[0]?.commands.map((command) => command.type)).toEqual([
        "get_state",
        "prompt",
      ]);

      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/auth.ts" },
      });
      fake.controls[0]?.offer({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "auth source" }] },
        isError: false,
      });
      fake.controls[0]?.offer({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Review complete." },
      });
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Review complete." }],
          usage: { totalTokens: 12, cost: { total: 0.001 } },
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const completed = yield* service.status(started.id);
      expect(completed.finalText).toBe("Review complete.");
      expect(completed.usage.totalTokens).toBe(12);
      expect(completed.transcript.join("\n")).toContain("Review complete.");
      expect(completed.sessionEvents).toMatchObject([
        { type: "tool", toolName: "read", target: "src/auth.ts", state: "completed" },
        { type: "assistant", text: "Review complete." },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("routes blocking child questions and peer notices through supervisor IPC", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = SubagentService.layer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "reader-one", execution: "foreground" }));
      fake.controls[0]?.offer({
        type: "extension_ui_request",
        id: "dialog-1",
        method: "confirm",
      });
      yield* yieldUntil(
        () =>
          fake.controls[0]?.commands.some((command) => command.type === "extension_ui_response") ??
          false,
      );
      expect(fake.controls[0]?.commands).toContainEqual({
        type: "extension_ui_response",
        id: "dialog-1",
        cancelled: true,
      });
      fake.controls[0]?.offer({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which API should I use?",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");

      const waiting = yield* service.waitForForeground(first.id);
      expect(waiting.question?.message).toBe("Which API should I use?");
      const replied = yield* service.reply(first.id, "Use the public API.");
      expect(replied.state).toBe("running");
      expect(fake.controls[0]?.ipc).toContainEqual({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: "question-1",
        message: "Use the public API.",
      });

      yield* service.start(request({ name: "reader-two", task: "Review tests" }));
      expect(
        fake.controls[0]?.ipc.some(
          (message) => message.type === "peer_notice" && message.message.includes("reader-two"),
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("does not resume a completed writer while another writer owns the cwd", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = SubagentService.layer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "writer-one", writeIntent: "writer", task: "Implement auth" }),
      );
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );

      const conflict = yield* Effect.flip(service.resume(first.id, "Make another edit"));
      expect(conflict._tag).toBe("SubagentWriterConflictError");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("terminates a child after malformed known protocol input", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = SubagentService.layer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "bad-protocol" }));
      fake.controls[0]?.offer({ type: "tool_execution_start" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      expect(fake.controls[0]?.terminations).toContain("force");
      fake.controls[0]?.offer({ type: "agent_start" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Effect.yieldNow;
      expect((yield* service.list)[0]?.state).toBe("failed");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("keeps a failed resume terminal and redacts the RPC error", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const layer = SubagentService.layer({
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "resume-failure" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      fake.controls[0]?.failNext("prompt", "token=secret-value");

      const failure = yield* Effect.flip(service.resume(run.id, "Continue"));
      expect(failure.message).toContain("[REDACTED]");
      expect(failure.message).not.toContain("secret-value");
      expect((yield* service.status(run.id)).state).toBe("failed");
      expect(fake.controls[0]?.terminations).toContain("force");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("retains only the newest 50 terminal records", () => {
    const fake = fakeChildLayer();
    const layer = SubagentService.layer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      let firstId = "";
      for (let index = 0; index < 51; index += 1) {
        const run = yield* service.start(request({ name: `history-${index}` }));
        if (index === 0) firstId = run.id;
        yield* service.stop(run.id);
      }
      const history = yield* service.list;
      expect(history).toHaveLength(50);
      expect(history.some((run) => run.id === firstId)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("rejects a second shared-cwd writer until the first writer stops", () => {
    const fake = fakeChildLayer();
    const layer = SubagentService.layer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(
        request({ name: "writer-one", writeIntent: "writer", task: "Implement auth" }),
      );
      const conflict = yield* Effect.flip(
        service.start(
          request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
        ),
      );
      expect(conflict._tag).toBe("SubagentWriterConflictError");

      const stopped = yield* service.stop(first.id);
      expect(stopped.state).toBe("stopped");
      const second = yield* service.start(
        request({ name: "writer-two", writeIntent: "writer", task: "Implement tests" }),
      );
      expect(second.state).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
