import { assert, describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { yieldUntil } from "pi-cosmic-core/testing";
import { localClaudeBackendDriver } from "../src/backend/local-claude.ts";
import type { ClaudeInboundFrame } from "../src/backend/local-claude-protocol.ts";
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
} from "./fixtures/backend-supervisor.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

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
                  tools: Arr.map(inventory, (name) => ({ name })),
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
              tools: Arr.map(SUPERVISOR_MCP_TOOL_NAMES, supervisorTool),
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
        Arr.some(sent, (frame) => isHookAnswer(frame) && frame.response.request_id === requestId),
      );
      const answer = Option.getOrUndefined(
        Arr.findFirst(
          sent,
          (frame) => isHookAnswer(frame) && frame.response.request_id === requestId,
        ),
      );
      return isHookAnswer(answer) ? answer.response.response : yield* Effect.die("No answer.");
    });
  return { backend, sent, hookCallback, answerTo };
});

describe("native sub-agent report ownership", () => {
  it.effect(
    "Claude refuses a native sub-agent's report or parent contact before the call runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { sent, hookCallback, answerTo } = yield* startedClaude;
          const registration = Option.getOrUndefined(Arr.findFirst(sent, isHookRegistration));
          assert(registration !== undefined);
          const matchers = Arr.flatMap(registration.request.hooks.PreToolUse, (entry) =>
            Str.split(entry.matcher, "|"),
          );
          expect(matchers).toEqual(
            expect.arrayContaining([
              supervisorTool("agent_submit_report"),
              supervisorTool("agent_contact_parent"),
              supervisorTool("agent_send"),
            ]),
          );
          for (const name of ["agent_list", "agent_read"])
            expect(matchers).not.toContain(supervisorTool(name));

          hookCallback("sub-agent-report", supervisorTool("agent_submit_report"), "a6a15e2");
          const refused = yield* answerTo("sub-agent-report");
          expect(refused.hookSpecificOutput?.permissionDecision).toBe("deny");
          expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain("parent");

          hookCallback("sub-agent-send", supervisorTool("agent_send"), "a6a15e2");
          expect((yield* answerTo("sub-agent-send")).hookSpecificOutput?.permissionDecision).toBe(
            "deny",
          );

          hookCallback("main-report", supervisorTool("agent_submit_report"));
          expect((yield* answerTo("main-report")).hookSpecificOutput).toBeUndefined();
        }),
      ),
  );

  it.effect("Claude starts only when the supervisor server lists exactly its tool set", () =>
    Effect.gen(function* () {
      const fewer = Arr.filter(SUPERVISOR_MCP_TOOL_NAMES, (name) => name !== "agent_read");
      for (const inventory of [fewer, [...SUPERVISOR_MCP_TOOL_NAMES, "agent_spawn"]]) {
        const { backend } = yield* claudeBackend(inventory);
        expect(yield* backend.controls.initialize.pipe(Effect.flip)).toMatchObject({
          code: "claude_supervisor_tools_missing",
        });
      }
    }).pipe(Effect.scoped),
  );
});
