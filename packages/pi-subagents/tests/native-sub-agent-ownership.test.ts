import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { yieldUntil } from "pi-cosmic-core/testing";
import { localClaudeBackendDriver } from "../src/backend/local-claude.ts";
import type { ClaudeInboundFrame } from "../src/backend/local-claude-protocol.ts";
import { localCodexBackendDriver } from "../src/backend/local-codex.ts";
import type {
  LocalCliHandle,
  LocalCliOutboundFrame,
  LocalCliWireEvent,
} from "../src/boundary/local-cli-transport.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../src/supervisor/mcp-contract.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import {
  backendLaunch,
  backendSupervisor,
  supervisorMetadata,
  takeBackendEvent,
} from "./fixtures/backend-supervisor.ts";

const wireJson = Schema.decodeUnknownSync(Schema.Json);
const SESSION = "claude-ownership-session";
const supervisorTool = (name: string) => `mcp__${SUPERVISOR_MCP_REGISTRATION}__${name}`;

const HookAnswer = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Struct({
    request_id: Schema.String,
    response: Schema.Struct({
      hookSpecificOutput: Schema.optional(
        Schema.Struct({
          permissionDecision: Schema.String,
          permissionDecisionReason: Schema.String,
        }),
      ),
    }),
  }),
});
const isHookAnswer = Schema.is(HookAnswer);
const HookRegistration = Schema.Struct({
  type: Schema.Literal("control_request"),
  request: Schema.Struct({
    subtype: Schema.Literal("initialize"),
    hooks: Schema.Struct({
      PreToolUse: Schema.Array(Schema.Struct({ matcher: Schema.String })),
    }),
  }),
});
const isHookRegistration = Schema.is(HookRegistration);

const claudeBackend = (inventory: ReadonlyArray<string> = SUPERVISOR_MCP_TOOL_NAMES) =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const sent: LocalCliOutboundFrame[] = [];
    const offerChild = (value: ClaudeInboundFrame): void => {
      Queue.offerUnsafe(childEvents, { type: "message", value: wireJson(value) });
    };
    const answerControl = (frame: Extract<LocalCliOutboundFrame, { type: "control_request" }>) =>
      offerChild({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: Match.value(frame.request.subtype).pipe(
            Match.when("initialize", () => ({
              models: [{ value: "fixture", resolvedModel: "fixture" }],
            })),
            Match.when("mcp_status", () => ({
              mcpServers: [
                {
                  name: SUPERVISOR_MCP_REGISTRATION,
                  status: "connected",
                  tools: inventory.map((name) => ({ name })),
                },
              ],
            })),
            Match.orElse(() => ({})),
          ),
        },
      });
    const child: LocalCliHandle = {
      pid: 1,
      events: childEvents,
      awaitExit: Effect.never,
      acknowledge: () => {},
      terminate: () => Effect.void,
      send: (frame) =>
        Effect.sync(() => {
          sent.push(frame);
          if (!("type" in frame)) return;
          if (frame.type === "control_request") return answerControl(frame);
          if (frame.type !== "user") return;
          offerChild({
            type: "user",
            uuid: frame.uuid,
            isReplay: true,
            session_id: SESSION,
            message: frame.message,
          });
          offerChild({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: SESSION,
            user_message_uuid: frame.uuid,
          });
        }),
    };
    const backend = yield* localClaudeBackendDriver(
      {
        preflight: () => Effect.void,
        spawn: ({ launch }) =>
          Effect.sync(() => {
            offerChild({
              type: "system",
              subtype: "init",
              cwd: launch.cwd,
              session_id: SESSION,
              model: launch.model,
              tools: SUPERVISOR_MCP_TOOL_NAMES.map(supervisorTool),
              mcp_servers: [{ name: SUPERVISOR_MCP_REGISTRATION, status: "connected" }],
            });
            return child;
          }),
      },
      {
        open: () =>
          Effect.succeed(
            backendSupervisor(supervisorMetadata(), supervisorEvents, {
              hasAcceptedReport: () => Effect.succeed(false),
              acceptedReportForEpoch: () => Effect.undefined,
            }),
          ),
      },
    ).spawn(backendLaunch());
    return { backend, sent, offerChild };
  });

const startedClaude = Effect.gen(function* () {
  const { backend, sent, offerChild } = yield* claudeBackend();
  yield* backend.controls.initialize;
  const hookCallback = (requestId: string, toolName: string, agentId?: string) =>
    offerChild({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "hook_callback",
        input: {
          hook_event_name: "PreToolUse",
          session_id: SESSION,
          tool_name: toolName,
          tool_input: { delivery_id: "report-1", report: "Done." },
          tool_use_id: `${requestId}-tool-use`,
          ...(agentId !== undefined && { agent_id: agentId, agent_type: "general-purpose" }),
        },
      },
    });
  const answerTo = (requestId: string) =>
    Effect.gen(function* () {
      yield* yieldUntil(() =>
        sent.some((frame) => isHookAnswer(frame) && frame.response.request_id === requestId),
      );
      const answer = sent.find(
        (frame) => isHookAnswer(frame) && frame.response.request_id === requestId,
      );
      return isHookAnswer(answer) ? answer.response.response : yield* Effect.die("No answer.");
    });
  return { backend, sent, hookCallback, answerTo };
});

describe("native sub-agent report ownership", () => {
  it.effect("Claude refuses a native sub-agent's report or question before the call runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { sent, hookCallback, answerTo } = yield* startedClaude;
        const registration = sent.find(isHookRegistration);
        const matchers = registration?.request.hooks.PreToolUse.flatMap((entry) =>
          entry.matcher.split("|"),
        );
        expect(matchers).toEqual(
          expect.arrayContaining([
            supervisorTool("supervisor_submit_report"),
            supervisorTool("supervisor_question"),
            supervisorTool("agent_send"),
          ]),
        );
        for (const name of [
          "supervisor_progress",
          "supervisor_warning",
          "agent_list",
          "agent_read",
        ])
          expect(matchers).not.toContain(supervisorTool(name));

        hookCallback("sub-agent-report", supervisorTool("supervisor_submit_report"), "a6a15e2");
        const refused = yield* answerTo("sub-agent-report");
        expect(refused.hookSpecificOutput?.permissionDecision).toBe("deny");
        expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain("parent");

        hookCallback("sub-agent-send", supervisorTool("agent_send"), "a6a15e2");
        expect((yield* answerTo("sub-agent-send")).hookSpecificOutput?.permissionDecision).toBe(
          "deny",
        );

        hookCallback("main-report", supervisorTool("supervisor_submit_report"));
        expect((yield* answerTo("main-report")).hookSpecificOutput).toBeUndefined();
      }),
    ),
  );

  it.effect("Claude starts only when the supervisor server lists exactly its tool set", () =>
    Effect.gen(function* () {
      const fewer = SUPERVISOR_MCP_TOOL_NAMES.filter((name) => name !== "agent_read");
      for (const inventory of [fewer, [...SUPERVISOR_MCP_TOOL_NAMES, "agent_spawn"]]) {
        const { backend } = yield* claudeBackend(inventory);
        expect(yield* backend.controls.initialize.pipe(Effect.flip)).toMatchObject({
          code: "claude_supervisor_tools_missing",
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("Codex names its main thread and follows 0.162 sub-agent activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
        const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
        const mainThreads: string[] = [];
        const notify = (method: string, params: Schema.Json) =>
          Queue.offerUnsafe(childEvents, { type: "message", value: { method, params } });
        const child: LocalCliHandle = {
          pid: 1,
          events: childEvents,
          awaitExit: Effect.never,
          acknowledge: () => {},
          terminate: () => Effect.void,
          send: (frame) =>
            Effect.sync(() => {
              if (!("id" in frame) || !("method" in frame)) return;
              const result = Match.value(frame.method).pipe(
                Match.when("initialize", () => ({
                  codexHome: "/tmp",
                  platformFamily: "unix",
                  platformOs: "macos",
                  userAgent: "fixture",
                })),
                Match.when("thread/start", () => ({
                  model: "fixture",
                  cwd: process.cwd(),
                  serviceTier: null,
                  thread: { id: "main-thread" },
                })),
                Match.orElse(() => ({ turn: { id: "main-turn", status: "inProgress" } })),
              );
              Queue.offerUnsafe(childEvents, { type: "message", value: { id: frame.id, result } });
            }),
        };
        const backend = yield* localCodexBackendDriver(
          { preflight: () => Effect.void, spawn: () => Effect.succeed(child) },
          {
            open: () =>
              Effect.succeed(
                backendSupervisor(supervisorMetadata({ tomlFragment: "" }), supervisorEvents, {
                  hasAcceptedReport: () => Effect.succeed(true),
                  acceptedReportForEpoch: () => Effect.undefined,
                  setMainAgentThread: (threadId) => void mainThreads.push(threadId),
                }),
              ),
          },
        ).spawn(backendLaunch());
        yield* backend.controls.initialize;
        expect(mainThreads).toEqual(["main-thread"]);
        yield* backend.controls.start("Start", 1);
        expect(yield* takeBackendEvent(backend)).toMatchObject({ type: "run_started" });

        const mainItem = (method: string, item: Schema.Json) =>
          notify(method, { threadId: "main-thread", turnId: "main-turn", item });
        const spawned = {
          id: "call-spawn",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "sub-thread",
          agentPath: "/root/report",
          model: "gpt-native",
          reasoningEffort: "low",
        };
        mainItem("item/started", spawned);
        mainItem("item/completed", spawned);
        mainItem("item/completed", {
          id: "call-message",
          type: "collabAgentToolCall",
          tool: "sendMessage",
          status: "interrupted",
          senderThreadId: "main-thread",
          receiverThreadIds: ["sub-thread"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { "sub-thread": { status: "interrupted" } },
        });
        notify("item/completed", {
          threadId: "sub-thread",
          turnId: "sub-turn",
          item: { id: "call-list", type: "collabAgentToolCall", tool: "listAgentsLater" },
        });
        mainItem("item/completed", {
          ...spawned,
          id: "subagent-completed",
          kind: "completed",
          model: null,
          reasoningEffort: null,
        });

        const states: string[] = [];
        while (states.length < 3) {
          const event = yield* takeBackendEvent(backend);
          expect(event.type).not.toBe("protocol_error");
          if (event.type === "native_agent_activity") states.push(event.state);
        }
        expect(states).toEqual(["running", "activity", "completed"]);
      }),
    ),
  );
});
