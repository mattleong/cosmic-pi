import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import {
  decodeClaudeProtocolEvent,
  type ClaudeInboundFrame,
  type ClaudeUserFrame,
} from "../src/backend/local-claude-protocol.ts";
import type { BackendHandle, BackendLaunchRequest } from "../src/backend/model.ts";
import type { LocalCliProcessContract } from "../src/boundary/local-cli-process.ts";
import type {
  LocalCliHandle,
  LocalCliOutboundFrame,
  LocalCliWireEvent,
} from "../src/boundary/local-cli-transport.ts";
import type {
  SupervisorChannelContract,
  SupervisorChannelHandle,
} from "../src/boundary/supervisor-channel.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";

const SUPERVISOR_TOOLS = [
  "supervisor_progress",
  "supervisor_warning",
  "supervisor_question",
  "supervisor_submit_report",
] as const;

type ReplayScenario =
  | "forwarded-user"
  | "uuidless-task-notification"
  | "cross-session-task-notification"
  | "nonsynthetic-task-notification"
  | "foreign-replay";

const launch = (model: ReplayScenario): BackendLaunchRequest => ({
  runId: `agent-${model}`,
  name: "claude-replay-worker",
  closeOnReport: true,
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model,
  effort: "high",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Use the private supervisor report tool.",
});

interface ReplayHarness {
  readonly processes: LocalCliProcessContract;
  readonly supervisors: SupervisorChannelContract;
  readonly close: Effect.Effect<void>;
}

const makeReplayHarness = (scenario: ReplayScenario): Effect.Effect<ReplayHarness> =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    const offerChild = (value: ClaudeInboundFrame): void => {
      Queue.offerUnsafe(childEvents, { type: "message", value });
    };
    const offerReplay = (frame: ClaudeUserFrame): void => {
      offerChild({
        type: "user",
        uuid: frame.uuid,
        isReplay: true,
        session_id: "claude-replay-session",
        message: frame.message,
      });
    };
    const send = (outbound: LocalCliOutboundFrame) =>
      Effect.sync(() => {
        if (!("type" in outbound)) return;
        if (outbound.type === "control_request") {
          if (outbound.request.subtype === "initialize") {
            offerChild({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: outbound.request_id,
                response: { models: [{ value: scenario, resolvedModel: scenario }] },
              },
            });
            return;
          }
          if (outbound.request.subtype === "mcp_status") {
            offerChild({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: outbound.request_id,
                response: {
                  mcpServers: [
                    {
                      name: "pi_subagents_supervisor",
                      status: "connected",
                      tools: SUPERVISOR_TOOLS.map((name) => ({ name })),
                    },
                  ],
                },
              },
            });
            return;
          }
          offerChild({
            type: "control_response",
            response: { subtype: "success", request_id: outbound.request_id },
          });
          return;
        }

        if (outbound.type !== "user") return;
        offerReplay(outbound);
        if (outbound.shouldQuery === false) {
          offerChild({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "claude-replay-session",
            user_message_uuid: outbound.uuid,
          });
          return;
        }

        offerChild({
          type: "assistant",
          session_id: "claude-replay-session",
          message: {
            id: "assistant-message",
            role: "assistant",
            content: [{ type: "text", text: "Working" }],
            usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 },
          },
        });
        if (scenario === "forwarded-user")
          offerChild({
            type: "user",
            uuid: "forwarded-user-uuid",
            parent_tool_use_id: "native-agent-tool-use",
            isSynthetic: true,
            origin: { kind: "unclassified" },
            session_id: "claude-replay-session",
            message: { role: "user", content: "Forwarded native-agent text." },
          });
        if (scenario === "uuidless-task-notification") {
          offerChild({
            type: "user",
            isSynthetic: true,
            origin: { kind: "task-notification" },
            session_id: "claude-replay-session",
            message: { role: "user", content: "A background task completed." },
          });
          offerChild({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "claude-replay-session",
            origin: { kind: "task-notification" },
          });
        }
        if (scenario === "cross-session-task-notification")
          offerChild({
            type: "user",
            uuid: "cross-session-uuid",
            isSynthetic: true,
            origin: { kind: "task-notification", subkind: "peer-send-message" },
            session_id: "claude-replay-session",
            message: { role: "user", content: "Message from another session." },
          });
        if (scenario === "nonsynthetic-task-notification")
          offerChild({
            type: "user",
            uuid: "nonsynthetic-notification-uuid",
            isSynthetic: false,
            origin: { kind: "task-notification" },
            session_id: "claude-replay-session",
            message: { role: "user", content: "Untrusted task-shaped input." },
          });
        if (scenario === "foreign-replay")
          offerChild({
            type: "user",
            uuid: "foreign-replay-uuid",
            isReplay: true,
            session_id: "claude-replay-session",
            message: { role: "user", content: "Foreign injected input." },
          });
        offerChild({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "claude-replay-session",
          user_message_uuid: outbound.uuid,
          usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 1 },
          total_cost_usd: 0.001,
        });
      });

    const child: LocalCliHandle = {
      pid: 1,
      events: childEvents,
      awaitExit: Effect.never,
      send,
      acknowledge: () => {},
      terminate: () => Effect.sync(() => Queue.endUnsafe(childEvents)),
    };
    const processes: LocalCliProcessContract = {
      preflight: () => Effect.void,
      spawn: ({ launch: request }) =>
        Effect.sync(() => {
          offerChild({
            type: "system",
            subtype: "init",
            cwd: request.cwd,
            session_id: "claude-replay-session",
            model: request.model,
            tools: SUPERVISOR_TOOLS.map((tool) => `mcp__pi_subagents_supervisor__${tool}`),
            mcp_servers: [{ name: "pi_subagents_supervisor", status: "connected" }],
          });
          return child;
        }),
    };
    const supervisors: SupervisorChannelContract = {
      open: ({ runId }) => {
        const handle: SupervisorChannelHandle = {
          runId,
          metadata: {
            runId,
            host: "127.0.0.1",
            port: 1,
            stateDirectory: "/private/fixture",
            connectionConfigPath: "/private/fixture/connection.json",
            helperPath: "/private/helper.mjs",
            claudeMcp: {
              mcpServers: {
                pi_subagents_supervisor: {
                  type: "stdio",
                  command: process.execPath,
                  args: ["/private/helper.mjs"],
                  env: {},
                },
              },
            },
            codexMcp: {
              serverName: "pi_subagents_supervisor",
              command: process.execPath,
              args: ["/private/helper.mjs"],
              enabledTools: [...SUPERVISOR_TOOLS],
              tomlFragment: "[mcp_servers.pi_subagents_supervisor]\nrequired = true",
            },
          },
          events: supervisorEvents,
          awaitReady: Effect.void,
          setAssignmentEpoch: () => Effect.void,
          hasAcceptedReport: () => Effect.succeed(true),
          acceptedReportForEpoch: () => Effect.sync((): undefined => undefined),
          deliverNotification: () => Effect.void,
          reply: () => Effect.void,
          cancelPending: () => {},
          close: Effect.sync(() => Queue.endUnsafe(supervisorEvents)),
        };
        return Effect.succeed(handle);
      },
    };
    return {
      processes,
      supervisors,
      close: Effect.sync(() => {
        Queue.endUnsafe(childEvents);
        Queue.endUnsafe(supervisorEvents);
      }),
    };
  });

const withReplayHarness = <A, E>(
  scenario: ReplayScenario,
  use: (harness: ReplayHarness) => Effect.Effect<A, E, import("effect/Scope").Scope>,
): Effect.Effect<A, E> =>
  Effect.scoped(Effect.acquireUseRelease(makeReplayHarness(scenario), use, ({ close }) => close));

const take = (backend: BackendHandle) =>
  Queue.take(backend.events).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap((event) =>
      Option.isSome(event) ? Effect.succeed(event.value) : Effect.die("fixture event timeout"),
    ),
    Effect.tap((event) => Effect.sync(() => backend.acknowledge(event))),
  );

const expectInternalUserFrame = (scenario: ReplayScenario) =>
  withReplayHarness(scenario, ({ processes, supervisors }) =>
    Effect.gen(function* () {
      const backend = yield* makeLocalClaudeBackendDriver(processes, supervisors).spawn(
        launch(scenario),
      );
      yield* backend.controls.initialize;
      yield* backend.controls.start("Run the replay fixture", 8);

      expect(yield* take(backend)).toMatchObject({ type: "run_started", assignmentEpoch: 8 });
      expect(yield* take(backend)).toMatchObject({ type: "assistant_message", assignmentEpoch: 8 });
      expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 8 });
      expect(yield* take(backend)).toMatchObject({
        type: "assistant_message",
        assignmentEpoch: 8,
        usage: expect.objectContaining({ cost: 0.001 }),
      });
      expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
    }),
  );

const takeRejectedUserFrame = (scenario: ReplayScenario, epoch: number) =>
  withReplayHarness(scenario, ({ processes, supervisors }) =>
    Effect.gen(function* () {
      const backend = yield* makeLocalClaudeBackendDriver(processes, supervisors).spawn(
        launch(scenario),
      );
      yield* backend.controls.initialize;
      yield* backend.controls.start("Reject untrusted input", epoch);
      expect(yield* take(backend)).toMatchObject({ type: "run_started", assignmentEpoch: epoch });
      expect(yield* take(backend)).toMatchObject({
        type: "assistant_message",
        assignmentEpoch: epoch,
      });
      return yield* take(backend);
    }),
  );

describe("local Claude replay classification", () => {
  it.effect("retains parent and origin classification fields at the protocol boundary", () =>
    Effect.gen(function* () {
      const user = yield* decodeClaudeProtocolEvent({
        type: "user",
        uuid: "forwarded-user",
        parent_tool_use_id: "native-agent-tool-use",
        isSynthetic: true,
        origin: { kind: "task-notification", subkind: "peer-send-message" },
        message: { role: "user", content: "Forwarded text" },
      });
      expect(user).toMatchObject({
        type: "user",
        parentToolUseId: "native-agent-tool-use",
        originKind: "task-notification",
        originSubkind: "peer-send-message",
        isSynthetic: true,
      });

      const assistant = yield* decodeClaudeProtocolEvent({
        type: "assistant",
        parent_tool_use_id: "native-agent-tool-use",
        message: { role: "assistant", content: [] },
      });
      expect(assistant).toMatchObject({
        type: "assistant",
        parentToolUseId: "native-agent-tool-use",
      });
    }),
  );

  it.effect("treats forwarded native-agent user text as assignment activity", () =>
    expectInternalUserFrame("forwarded-user"),
  );

  it.effect("owns UUID-less internal notifications through their result lifecycle", () =>
    expectInternalUserFrame("uuidless-task-notification"),
  );

  it.effect("fails closed on cross-session task notifications", () =>
    Effect.gen(function* () {
      expect(yield* takeRejectedUserFrame("cross-session-task-notification", 9)).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining("subkind=peer-send-message"),
      });
    }),
  );

  it.effect("rejects task-shaped input that is not synthetic", () =>
    Effect.gen(function* () {
      expect(yield* takeRejectedUserFrame("nonsynthetic-task-notification", 10)).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining("synthetic=false"),
      });
    }),
  );

  it.effect("keeps foreign top-level UUIDs fail closed with bounded diagnostics", () =>
    Effect.gen(function* () {
      const failure = yield* takeRejectedUserFrame("foreign-replay", 11);
      expect(failure).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining("uuid=present"),
      });
      if (failure.type === "protocol_error") {
        expect(failure.message).toContain("session=match");
        expect(failure.message).toContain("parent-tool=absent");
        expect(failure.message).not.toContain("foreign-replay-uuid");
      }
    }),
  );
});
