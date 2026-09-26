import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import {
  decodeClaudeProtocolEvent,
  type ClaudeInboundFrame,
  type ClaudeUserFrame,
} from "../src/backend/local-claude-protocol.ts";
import type { BackendHandle } from "../src/backend/model.ts";
import type { LocalCliProcessContract } from "../src/boundary/local-cli-process.ts";
import type {
  LocalCliHandle,
  LocalCliOutboundFrame,
  LocalCliWireEvent,
} from "../src/boundary/local-cli-transport.ts";
import type { SupervisorChannelContract } from "../src/boundary/supervisor-channel.ts";
import type { SubagentError } from "../src/run/errors.ts";
import type { SupervisorEvent } from "../src/supervisor/protocol.ts";
import {
  backendLaunch,
  backendSupervisor,
  supervisorMetadata,
  takeBackendEvent,
} from "./fixtures/backend-supervisor.ts";

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
  | "foreign-replay"
  | "same-content-foreign-replay"
  | "known-replay-cross-session"
  | "queued-task-notification"
  | "queued-task-notification-duplicate"
  | "queued-task-notification-cross-session"
  | "tagged-task-notification-nonreplay"
  | "tagged-task-notification-channel"
  | "accepted-report-foreign-replay"
  | "accepted-report-result"
  | "accepted-report-cost-only"
  | "accepted-report-close";

interface ReplayHarness {
  readonly processes: LocalCliProcessContract;
  readonly supervisors: SupervisorChannelContract;
  readonly guidanceSent: Effect.Effect<void>;
  readonly replayGuidance: Effect.Effect<void>;
  readonly fillProgress: Effect.Effect<void>;
  readonly finishResult: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
}

const makeReplayHarness = (scenario: ReplayScenario): Effect.Effect<ReplayHarness> =>
  Effect.gen(function* () {
    const childEvents = yield* Queue.unbounded<LocalCliWireEvent, Cause.Done>();
    const supervisorEvents = yield* Queue.unbounded<SupervisorEvent, Cause.Done>();
    let pendingResult: ClaudeInboundFrame | undefined;
    let pendingGuidance: ClaudeUserFrame | undefined;
    const guidanceSent = Deferred.makeUnsafe<void>();
    const acceptedReport = scenario.startsWith("accepted-report-")
      ? {
          runId: `agent-${scenario}`,
          assignmentEpoch: 12,
          sequence: 1,
          deliveryId: "accepted-delivery",
          text: "Accepted report text",
          evidence: "accepted-report-evidence",
        }
      : undefined;
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
        if (outbound.message.content === "Delayed guidance") {
          pendingGuidance = outbound;
          Deferred.doneUnsafe(guidanceSent, Effect.void);
          return;
        }
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
        if (scenario === "accepted-report-foreign-replay" && acceptedReport)
          Queue.offerUnsafe(supervisorEvents, { type: "report", ...acceptedReport });
        if (scenario === "foreign-replay" || scenario === "accepted-report-foreign-replay")
          offerChild({
            type: "user",
            uuid: "foreign-replay-uuid",
            isReplay: true,
            session_id: "claude-replay-session",
            message: { role: "user", content: "Foreign injected input." },
          });
        if (
          scenario === "queued-task-notification" ||
          scenario === "queued-task-notification-duplicate" ||
          scenario === "queued-task-notification-cross-session" ||
          scenario === "tagged-task-notification-nonreplay" ||
          scenario === "tagged-task-notification-channel"
        ) {
          const notification: ClaudeInboundFrame = {
            type: "user",
            uuid: "claude-queued-notification-uuid",
            ...(scenario !== "tagged-task-notification-nonreplay" && { isReplay: true }),
            session_id:
              scenario === "queued-task-notification-cross-session"
                ? "different-claude-session"
                : "claude-replay-session",
            ...(scenario === "tagged-task-notification-channel" && {
              origin: { kind: "channel" },
            }),
            message: {
              role: "user",
              content:
                "<task-notification><task-id>native-task</task-id><status>completed</status><summary>Native task completed.</summary></task-notification>",
            },
          };
          offerChild(notification);
          if (scenario === "queued-task-notification-duplicate") offerChild(notification);
        }
        if (scenario === "same-content-foreign-replay")
          offerChild({
            type: "user",
            uuid: "same-content-foreign-uuid",
            isReplay: true,
            session_id: "claude-replay-session",
            message: outbound.message,
          });
        if (scenario === "known-replay-cross-session")
          offerChild({
            type: "user",
            uuid: outbound.uuid,
            isReplay: true,
            session_id: "different-claude-session",
            message: outbound.message,
          });
        if (scenario === "accepted-report-close") return;
        const result: ClaudeInboundFrame = {
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "claude-replay-session",
          user_message_uuid: outbound.uuid,
          ...(scenario !== "accepted-report-cost-only" && {
            usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 1 },
          }),
          total_cost_usd: 0.001,
        };
        if (
          (scenario === "accepted-report-result" || scenario === "accepted-report-cost-only") &&
          acceptedReport
        ) {
          pendingResult = result;
          Queue.offerUnsafe(supervisorEvents, { type: "report", ...acceptedReport });
          // Observing this progress proves the adapter has consumed the earlier
          // report event before the test releases native final telemetry.
          Queue.offerUnsafe(supervisorEvents, {
            type: "supervisor_contact",
            assignmentEpoch: 12,
            requestId: "after-report",
            kind: "progress",
            message: "Native finalization pending",
          });
        } else offerChild(result);
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
      open: () => {
        const handle = backendSupervisor(supervisorMetadata(), supervisorEvents, {
          hasAcceptedReport: () => Effect.succeed(true),
          acceptedReportForEpoch: (epoch) =>
            Effect.succeed(acceptedReport?.assignmentEpoch === epoch ? acceptedReport : undefined),
          close: Effect.sync(() => Queue.endUnsafe(supervisorEvents)),
        });
        return Effect.succeed(handle);
      },
    };
    return {
      processes,
      supervisors,
      guidanceSent: Deferred.await(guidanceSent),
      replayGuidance: Effect.sync(() => {
        if (pendingGuidance) offerReplay(pendingGuidance);
        offerChild({
          type: "assistant",
          session_id: "claude-replay-session",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Guidance consumed" }],
          },
        });
      }),
      fillProgress: Effect.sync(() => {
        for (let index = 0; index < 513; index++)
          Queue.offerUnsafe(supervisorEvents, {
            type: "supervisor_contact",
            assignmentEpoch: 12,
            requestId: `progress-${index}`,
            kind: "progress",
            message: "Working",
          });
      }),
      finishResult: Effect.sync(() => {
        if (pendingResult) offerChild(pendingResult);
        pendingResult = undefined;
      }),
      close: Effect.sync(() => {
        Queue.endUnsafe(childEvents);
        Queue.endUnsafe(supervisorEvents);
      }),
    };
  });

const withStartedBackend = <A, E>(
  scenario: ReplayScenario,
  epoch: number,
  use: (backend: BackendHandle, harness: ReplayHarness) => Effect.Effect<A, E, Scope>,
): Effect.Effect<A, E | SubagentError> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      makeReplayHarness(scenario),
      (harness) =>
        Effect.gen(function* () {
          const backend = yield* makeLocalClaudeBackendDriver(
            harness.processes,
            harness.supervisors,
          ).spawn(backendLaunch({ runId: `agent-${scenario}`, model: scenario }));
          yield* backend.controls.initialize;
          yield* backend.controls.start("Run the replay fixture", epoch);
          return yield* use(backend, harness);
        }),
      ({ close }) => close,
    ),
  );

const take = (backend: BackendHandle) => takeBackendEvent(backend, { acknowledge: true });

const expectInternalUserFrame = (scenario: ReplayScenario) =>
  withStartedBackend(scenario, 8, (backend) =>
    Effect.gen(function* () {
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

const takeRejectedUserFrame = (scenario: ReplayScenario) =>
  withStartedBackend(scenario, 9, (backend) =>
    Effect.gen(function* () {
      expect(yield* take(backend)).toMatchObject({ type: "run_started", assignmentEpoch: 9 });
      expect(yield* take(backend)).toMatchObject({ type: "assistant_message", assignmentEpoch: 9 });
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
        isMeta: true,
        isCompactSummary: true,
        origin: { kind: "task-notification", subkind: "peer-send-message" },
        message: { role: "user", content: "Forwarded text" },
      });
      expect(user).toMatchObject({
        type: "user",
        parentToolUseId: "native-agent-tool-use",
        originKind: "task-notification",
        originSubkind: "peer-send-message",
        isSynthetic: true,
        isMeta: true,
        isCompactSummary: true,
        contentKind: "text",
        textLength: 14,
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

  it.effect.each([
    ["treats forwarded native-agent user text as assignment activity", "forwarded-user"],
    [
      "owns UUID-less internal notifications through their result lifecycle",
      "uuidless-task-notification",
    ],
    ["owns Claude command-queue task-notification replays", "queued-task-notification"],
    [
      "suppresses duplicate internal task-notification replays without sent UUID aliasing",
      "queued-task-notification-duplicate",
    ],
  ] as const)("%s", ([, scenario]) => expectInternalUserFrame(scenario));

  it.effect.each([
    [
      "fails closed on cross-session task notifications",
      "cross-session-task-notification",
      "subkind=peer-send-message",
    ],
    ...(
      [
        "queued-task-notification-cross-session",
        "tagged-task-notification-nonreplay",
        "tagged-task-notification-channel",
      ] as const
    ).map(
      (scenario) =>
        [
          `rejects near-miss command-queue task notification ${scenario}`,
          scenario,
          "tag=task-notification",
        ] as const,
    ),
    [
      "rejects task-shaped input that is not synthetic",
      "nonsynthetic-task-notification",
      "synthetic=false",
    ],
    [
      "uses content matches only as evidence and never as replay authority",
      "same-content-foreign-replay",
      "content=assignment",
    ],
    [
      "rejects a confirmed UUID replayed from another native session",
      "known-replay-cross-session",
      "session=mismatch",
    ],
  ] as const)("%s", ([, scenario, diagnostic]) =>
    Effect.gen(function* () {
      expect(yield* takeRejectedUserFrame(scenario)).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining(diagnostic),
      });
    }),
  );

  it.effect("keeps foreign top-level UUIDs fail closed with bounded diagnostics", () =>
    Effect.gen(function* () {
      const failure = yield* takeRejectedUserFrame("foreign-replay");
      expect(failure).toMatchObject({
        type: "protocol_error",
        message: expect.stringContaining("uuid=present"),
      });
      if (failure.type === "protocol_error") {
        expect(failure.message).toContain("session=match");
        expect(failure.message).toContain("parent-tool=absent");
        expect(failure.message).toContain("report=none");
        expect(failure.message).not.toContain("foreign-replay-uuid");
        expect(failure.message).not.toContain("Foreign injected input");
      }
    }),
  );

  it.effect("queues final usage and cost before settling an already-buffered report", () =>
    Effect.gen(function* () {
      for (const scenario of ["accepted-report-result", "accepted-report-cost-only"] as const) {
        yield* withStartedBackend(scenario, 12, (backend, { finishResult, close }) =>
          Effect.gen(function* () {
            const initial = [yield* take(backend), yield* take(backend), yield* take(backend)];
            expect(initial).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ type: "run_started", assignmentEpoch: 12 }),
                expect.objectContaining({ type: "assistant_message", assignmentEpoch: 12 }),
                expect.objectContaining({ type: "supervisor_contact", kind: "progress" }),
              ]),
            );
            expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
            yield* finishResult;
            const remainder = scenario === "accepted-report-result" ? 2 : 0;
            expect(yield* take(backend)).toMatchObject({
              type: "assistant_message",
              assignmentEpoch: 12,
              usage: {
                input: remainder,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: remainder,
                cost: 0.001,
              },
            });
            expect(yield* take(backend)).toMatchObject({
              type: "report",
              assignmentEpoch: 12,
              text: "Accepted report text",
            });
            yield* close;
            // Transport recovery must not duplicate the report already forwarded.
            expect(yield* Stream.runCollect(Stream.fromQueue(backend.events))).toEqual([]);
          }),
        );
      }
    }),
  );

  it.effect("keeps exact UUID replay correlated after guidance caller cancellation", () =>
    withStartedBackend("accepted-report-close", 12, (backend, { guidanceSent, replayGuidance }) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
        yield* guidanceSent;
        yield* Fiber.interrupt(caller);
        yield* replayGuidance;
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          text: "Guidance consumed",
        });
      }),
    ),
  );

  it.effect("preserves accepted evidence behind a full queue and delayed consumer", () =>
    withStartedBackend("accepted-report-close", 12, (backend, { close, fillProgress }) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        yield* fillProgress;
        yield* yieldUntil(() => Queue.sizeUnsafe(backend.events) >= 512);
        yield* close;
        yield* TestClock.adjust("1200 millis");
        const received = yield* Stream.runCollect(Stream.fromQueue(backend.events));
        expect(received.filter((event) => event.type === "report")).toMatchObject([
          { assignmentEpoch: 12, text: "Accepted report text" },
        ]);
      }),
    ),
  );

  it.effect("recovers accepted evidence when transport closes before report forwarding", () =>
    withStartedBackend("accepted-report-close", 12, (backend, { close }) =>
      Effect.gen(function* () {
        expect(yield* take(backend)).toMatchObject({ type: "run_started" });
        expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
        yield* close;
        expect(yield* Stream.runCollect(Stream.fromQueue(backend.events))).toMatchObject([
          { type: "report", assignmentEpoch: 12, text: "Accepted report text" },
        ]);
      }),
    ),
  );

  it.effect("preserves an accepted report when a trailing unknown replay arrives", () =>
    withStartedBackend("accepted-report-foreign-replay", 12, (backend) =>
      Effect.gen(function* () {
        expect(yield* take(backend)).toMatchObject({ type: "run_started", assignmentEpoch: 12 });
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          assignmentEpoch: 12,
        });
        const warning = yield* take(backend);
        expect(warning).toMatchObject({
          type: "warning",
          source: "runtime-extension",
          message: expect.stringContaining("report=accepted"),
        });
        expect(yield* take(backend)).toMatchObject({
          type: "report",
          assignmentEpoch: 12,
          deliveryId: "accepted-delivery",
          text: "Accepted report text",
        });
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          assignmentEpoch: 12,
          usage: expect.objectContaining({ cost: 0.001 }),
        });
        expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
      }),
    ),
  );
});
