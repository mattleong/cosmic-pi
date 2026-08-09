import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type {
  ChildProcessHandle,
  ChildProcessShape,
  ChildWireEvent,
} from "../src/boundary/child-process.ts";
import { withHerdrSupervisorInstructions } from "../src/backend/herdr.ts";
import { makeLocalPiBackendDriver } from "../src/backend/local-pi.ts";
import type { RpcCommand } from "../src/backend/local-pi-protocol.ts";
import { withLocalSupervisorInstructions } from "../src/backend/local-supervisor-prompt.ts";
import type { BackendDriver } from "../src/backend/model.ts";
import { makeSubagentBackendRegistry } from "../src/backend/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";

const launch = {
  runId: "agent-1",
  name: "worker",
  closeOnReport: true,
  cwd: "/project",
  context: "fork" as const,
  writeIntent: "writer" as const,
  fastMode: false,
  model: "openai-codex/gpt-5.6-sol",
  effort: "high" as const,
  activeTools: ["read", "bash"],
  projectTrusted: true,
  parentSessionId: "parent-session",
  parentSessionFile: "/tmp/parent.jsonl",
  parentLeafId: "parent-leaf",
  systemPrompt: "Work on the assigned task.",
};

describe("subagent backend contract", () => {
  it("describes read-only Bash according to each runtime boundary", () => {
    const readOnlyLaunch = {
      ...launch,
      context: "fresh" as const,
      writeIntent: "read-only" as const,
    };
    expect(withLocalSupervisorInstructions(readOnlyLaunch).systemPrompt).toContain(
      "inside the runtime's strict filesystem sandbox",
    );
    expect(withHerdrSupervisorInstructions("claude", readOnlyLaunch).systemPrompt).toContain(
      "inside the runtime's strict filesystem sandbox",
    );
    expect(withHerdrSupervisorInstructions("pi", readOnlyLaunch).systemPrompt).toContain(
      "behavioral policy",
    );
  });

  it.effect("rejects unsafe local Pi model selectors before spawn ownership", () => {
    let spawns = 0;
    const driver = makeLocalPiBackendDriver({
      reclaimRunState: () => Effect.void,
      spawn: () => {
        spawns += 1;
        return Effect.die("unsafe selector must not spawn");
      },
    });
    return Effect.gen(function* () {
      for (const model of ["-leading-option", "model with spaces", "model,(glob)*"])
        expect(
          yield* driver
            .preflight({
              context: "fresh",
              writeIntent: "read-only",
              closeOnReport: true,
              model,
              effort: "high",
              cwd: "/project",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "pi_model_unsupported" });
      expect(spawns).toBe(0);
    });
  });

  it.effect("rejects unsupported selections before any driver spawn ownership begins", () => {
    let spawns = 0;
    const driver: BackendDriver = {
      host: "local",
      runtime: "pi",
      capabilities: [],
      supportsContext: (context) => context === "fresh",
      preflight: () => Effect.void,
      spawn: () => {
        spawns += 1;
        return Effect.die("must not spawn");
      },
    };
    const registry = makeSubagentBackendRegistry([driver]);
    return Effect.gen(function* () {
      const unsupported = yield* registry
        .resolve({ host: "herdr", runtime: "claude", context: "fresh" })
        .pipe(Effect.flip);
      expect(unsupported).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "backend_not_implemented",
      });

      const missingCapability = yield* registry
        .resolve({ host: "local", runtime: "pi", context: "fork" })
        .pipe(Effect.flip);
      expect(missingCapability).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "context_unsupported",
      });
      expect(spawns).toBe(0);
    });
  });

  it.effect("adapts local Pi RPC and IPC into normalized backend controls and events", () =>
    Effect.gen(function* () {
      const rawEvents = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
      const exited = yield* Deferred.make<Extract<ChildWireEvent, { readonly type: "exit" }>>();
      const commands: RpcCommand[] = [];
      const ipc: unknown[] = [];
      const acknowledged: ChildWireEvent[] = [];
      let capturedLaunch: Parameters<ChildProcessShape["spawn"]>[0] | undefined;

      const handle: ChildProcessHandle = {
        pid: 4242,
        events: rawEvents,
        acknowledge: (event) => void acknowledged.push(event),
        awaitExit: Deferred.await(exited),
        send: (command) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type === "extension_ui_response") return;
            Queue.offerUnsafe(rawEvents, {
              type: "rpc_message",
              value: {
                type: "response",
                id: command.id,
                command: command.type,
                success: true,
                data:
                  command.type === "get_state"
                    ? {
                        thinkingLevel: "high",
                        model: { provider: "openai-codex", id: "gpt-5.6-sol" },
                        sessionId: "child-session",
                        sessionFile: "/tmp/child.jsonl",
                      }
                    : undefined,
              },
            });
          }),
        sendIpc: (message) => Effect.sync(() => void ipc.push(message)),
        terminate: () => Effect.void,
      };
      const childProcesses: ChildProcessShape = {
        reclaimRunState: () => Effect.void,
        spawn: (request) => {
          capturedLaunch = request;
          return Effect.succeed(handle);
        },
      };
      const driver = makeLocalPiBackendDriver(childProcesses);
      const backend = yield* driver.spawn(launch);

      expect(driver.host).toBe("local");
      expect(driver.runtime).toBe("pi");
      expect(driver.capabilities).toContain("native-fork");
      expect(capturedLaunch).toMatchObject({
        context: "fork",
        parentSessionFile: "/tmp/parent.jsonl",
        parentLeafId: "parent-leaf",
      });

      const state = yield* backend.controls.initialize;
      expect(state).toMatchObject({
        model: "openai-codex/gpt-5.6-sol",
        effort: "high",
        sessionId: "child-session",
        sessionFile: "/tmp/child.jsonl",
      });
      yield* backend.controls.start("Initial task", 1);
      yield* backend.controls.steer("Focus on tests");
      yield* backend.controls.reply("question-1", "Proceed");
      yield* backend.controls.notifyPeers("Peer fleet changed");

      Queue.offerUnsafe(rawEvents, {
        type: "rpc_message",
        value: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Finished" }],
            usage: { input: 3, output: 5, totalTokens: 8, cost: { total: 0.01 } },
          },
        },
      });
      Queue.offerUnsafe(rawEvents, {
        type: "ipc_message",
        value: {
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "question-1",
          kind: "question",
          message: "May I proceed?",
        },
      });

      yield* Effect.yieldNow;
      expect(acknowledged).toHaveLength(3);
      const assistantEvent = yield* Queue.take(backend.events);
      expect(assistantEvent).toMatchObject({
        type: "assistant_message",
        assignmentEpoch: 1,
        text: "Finished",
        usage: { input: 3, output: 5, totalTokens: 8, cost: 0.01 },
      });
      expect(acknowledged).toHaveLength(3);
      backend.acknowledge(assistantEvent);
      expect(acknowledged).toHaveLength(4);
      const contactEvent = yield* Queue.take(backend.events);
      expect(contactEvent).toEqual({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "question-1",
        kind: "question",
        message: "May I proceed?",
      });
      backend.acknowledge(contactEvent);
      expect(acknowledged).toHaveLength(5);
      expect(commands.map((command) => command.type)).toEqual(["get_state", "prompt", "steer"]);
      expect(ipc).toEqual([
        {
          channel: "pi-subagents",
          type: "parent_reply",
          requestId: "question-1",
          message: "Proceed",
        },
        { channel: "pi-subagents", type: "peer_notice", message: "Peer fleet changed" },
      ]);

      Queue.endUnsafe(rawEvents);
      Deferred.doneUnsafe(exited, Effect.succeed({ type: "exit", exitCode: 0, stderr: "" }));
      expect(yield* backend.awaitExit).toEqual({
        type: "exit",
        exitCode: 0,
        diagnostic: "",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a mismatched correlated command without disturbing concurrent RPCs", () =>
    Effect.gen(function* () {
      const rawEvents = yield* Queue.unbounded<ChildWireEvent, Cause.Done>();
      const exited = yield* Deferred.make<Extract<ChildWireEvent, { readonly type: "exit" }>>();
      const commands: RpcCommand[] = [];
      const handle: ChildProcessHandle = {
        pid: 4343,
        events: rawEvents,
        awaitExit: Deferred.await(exited),
        send: (command) => Effect.sync(() => void commands.push(command)),
        sendIpc: () => Effect.void,
        terminate: () => Effect.void,
      };
      const backend = yield* makeLocalPiBackendDriver({
        reclaimRunState: () => Effect.void,
        spawn: () => Effect.succeed(handle),
      }).spawn(launch);
      const prompting = yield* backend.controls.start("First", 1).pipe(Effect.forkScoped);
      const steering = yield* backend.controls.steer("Second").pipe(Effect.forkScoped);
      yield* yieldUntil(() => commands.length === 2);
      const prompt = commands.find((command) => command.type === "prompt");
      const steer = commands.find((command) => command.type === "steer");
      expect(prompt?.id).toBeDefined();
      expect(steer?.id).toBeDefined();

      Queue.offerUnsafe(rawEvents, {
        type: "rpc_message",
        value: {
          type: "response",
          id: prompt?.id,
          command: "steer",
          success: true,
        },
      });
      Queue.offerUnsafe(rawEvents, {
        type: "rpc_message",
        value: {
          type: "response",
          id: steer?.id,
          command: "steer",
          success: true,
        },
      });

      expect(yield* Fiber.join(prompting).pipe(Effect.flip)).toMatchObject({
        _tag: "SubagentProtocolError",
      });
      yield* Fiber.join(steering);
      const protocolEvent = yield* Queue.take(backend.events);
      expect(protocolEvent).toEqual({
        type: "protocol_error",
        message: "Subagent returned a mismatched RPC response command.",
      });
      backend.acknowledge(protocolEvent);
    }).pipe(Effect.scoped),
  );
});
