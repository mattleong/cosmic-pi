import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import { SENT_UUID_LIMIT } from "../src/backend/local-claude-correlation.ts";
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
  | "steering"
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

/**
 * Claude 2.1.28x replays a task notification drained into a running turn with
 * a fresh UUID and its derived unqualified origin; the other forms are near misses.
 */
type TaskNotificationReplay =
  | "labelled"
  | "unlabelled"
  | "qualified"
  | "untagged"
  | "cross-session"
  | "auto-continuation";

const TASK_NOTIFICATION =
  "<task-notification><task-id>background-shell</task-id><status>completed</status><summary>Background command completed.</summary></task-notification>";

interface ReplayHarness {
  readonly processes: LocalCliProcessContract;
  readonly supervisors: SupervisorChannelContract;
  readonly guidanceSent: Effect.Effect<void>;
  readonly replayGuidance: Effect.Effect<void>;
  /** Offers a Claude-owned replay; passing a previous UUID repeats that replay. */
  readonly taskNotification: (form: TaskNotificationReplay, uuid?: string) => Effect.Effect<string>;
  readonly assignmentResult: Effect.Effect<void>;
  readonly rejectReplay: (
    kind: "wrong-uuid" | "wrong-session" | "absent-session",
  ) => Effect.Effect<void>;
  readonly acceptReport: (epoch: number, forward?: boolean) => Effect.Effect<void>;
  readonly activity: Effect.Effect<void>;
  readonly resultError: (
    kind: "assignment" | "foreign-session" | "unknown-input",
  ) => Effect.Effect<void>;
  readonly terminations: () => number;
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
    let assignmentUuid: string | undefined;
    let taskNotifications = 0;
    const guidanceSent = Deferred.makeUnsafe<void>();
    const exited = Deferred.makeUnsafe<{ exitCode: number; stderr: string }>();
    let terminations = 0;
    let acceptedReport = scenario.startsWith("accepted-report-")
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
        if (scenario === "steering") {
          assignmentUuid = outbound.uuid;
          return;
        }
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
      awaitExit: Deferred.await(exited).pipe(
        Effect.map((exit) => ({ type: "exit" as const, ...exit })),
      ),
      send,
      acknowledge: () => {},
      terminate: () =>
        Effect.sync(() => {
          terminations++;
          Deferred.doneUnsafe(exited, Effect.succeed({ exitCode: 1, stderr: "" }));
          Queue.endUnsafe(childEvents);
        }),
    };
    const processes: LocalCliProcessContract = {
      preflight: () => Effect.void,
      spawn: ({ launch: request }) =>
        Effect.sync(() => {
          offerChild({
            type: "system",
            subtype: "init",
            claude_code_version: "2.1.259",
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
      terminations: () => terminations,
      resultError: (kind) =>
        Effect.sync(() =>
          offerChild({
            type: "result",
            is_error: true,
            subtype: "error_during_execution",
            user_message_uuid: kind === "unknown-input" ? "foreign-input" : assignmentUuid,
            session_id: kind === "foreign-session" ? "foreign-session" : "claude-replay-session",
          }),
        ),
      acceptReport: (epoch, forward = true) =>
        Effect.sync(() => {
          acceptedReport = {
            runId: `agent-${scenario}`,
            assignmentEpoch: epoch,
            sequence: 1,
            deliveryId: "late-report",
            text: "Completed assignment",
            evidence: "accepted",
          };
          if (forward) Queue.offerUnsafe(supervisorEvents, { type: "report", ...acceptedReport });
        }),
      activity: Effect.sync(() =>
        offerChild({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "private-tool-id",
                name: "Bash",
                input: { command: "private command" },
              },
            ],
          },
        }),
      ),
      rejectReplay: (kind) =>
        Effect.sync(() => {
          if (!pendingGuidance) return;
          offerChild({
            type: "user",
            uuid: kind === "wrong-uuid" ? "foreign-guidance-id" : pendingGuidance.uuid,
            isReplay: true,
            ...(kind !== "absent-session" && {
              session_id: kind === "wrong-session" ? "foreign-session" : "claude-replay-session",
            }),
            message: pendingGuidance.message,
          });
        }),
      taskNotification: (form, repeated) =>
        Effect.sync(() => {
          taskNotifications += 1;
          const uuid = repeated ?? `claude-task-notification-${taskNotifications}`;
          offerChild({
            type: "user",
            uuid,
            isReplay: true,
            session_id:
              form === "cross-session" ? "different-claude-session" : "claude-replay-session",
            ...(form !== "unlabelled" && {
              origin: {
                kind: form === "auto-continuation" ? "auto-continuation" : "task-notification",
                ...(form === "qualified" && { subkind: "peer-send-message" }),
              },
            }),
            message: {
              role: "user",
              content: form === "untagged" ? "A background command completed." : TASK_NOTIFICATION,
            },
          });
          return uuid;
        }),
      assignmentResult: Effect.sync(() =>
        offerChild({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "claude-replay-session",
          user_message_uuid: assignmentUuid,
          usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 1 },
          total_cost_usd: 0.001,
        }),
      ),
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
        Deferred.doneUnsafe(exited, Effect.succeed({ exitCode: 0, stderr: "" }));
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

describe("local Claude steering acknowledgement lifecycle", () => {
  for (const kind of [
    "assignment",
    "foreign-session",
    "unknown-input",
    "wrong-report-epoch",
  ] as const)
    it.effect(`checks causal report acceptance before failing a ${kind} native result`, () =>
      withStartedBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* take(backend);
          yield* take(backend);
          const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
          yield* harness.guidanceSent;
          yield* take(backend);
          yield* TestClock.adjust("11 seconds");
          yield* Fiber.await(caller);
          yield* harness.acceptReport(kind === "wrong-report-epoch" ? 13 : 12, false);
          yield* harness.resultError(kind === "wrong-report-epoch" ? "assignment" : kind);
          if (kind === "assignment") {
            expect(yield* take(backend)).toMatchObject({ type: "warning" });
            expect(yield* take(backend)).toMatchObject({
              type: "input_delivery",
              state: "report-unconfirmed",
            });
            expect(yield* take(backend)).toMatchObject({ type: "report", assignmentEpoch: 12 });
            expect(harness.terminations()).toBe(0);
          } else expect(yield* take(backend)).toMatchObject({ type: "protocol_error" });
        }),
      ),
    );
  it.effect(
    "survives the caller deadline, rejects new send and cancel_queued interrupt, then confirms late",
    () =>
      withStartedBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* take(backend);
          yield* take(backend);
          const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
          yield* harness.guidanceSent;
          expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "pending" });
          yield* TestClock.adjust("11 seconds");
          // Typed pending evidence reaches the caller only while the backend still tracks guidance.
          expect(yield* Effect.flip(Fiber.join(caller))).toMatchObject({
            operation: "steer",
            code: "steer_outcome_uncertain",
            pendingDelivery: true,
          });
          expect(harness.terminations()).toBe(0);
          const rejected = yield* Effect.flip(backend.controls.steer("Another guidance"));
          expect(rejected).toMatchObject({ code: "steer_not_sent" });
          expect(rejected).not.toMatchObject({ pendingDelivery: true });
          expect(yield* Effect.flip(backend.controls.interrupt)).toMatchObject({
            code: "interrupt_not_sent",
          });
          yield* harness.activity;
          expect(yield* take(backend)).toMatchObject({ type: "tool_started" });
          yield* take(backend);
          yield* harness.replayGuidance;
          expect(yield* take(backend)).toMatchObject({
            type: "input_delivery",
            state: "confirmed",
          });
          yield* take(backend);
          yield* backend.controls.steer("New guidance");
          expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "pending" });
          expect(yield* take(backend)).toMatchObject({
            type: "input_delivery",
            state: "confirmed",
          });
          expect(harness.terminations()).toBe(0);
        }),
      ),
  );

  for (const kind of ["wrong-uuid", "wrong-session", "absent-session"] as const)
    it.effect(`does not confirm same-text guidance from ${kind}`, () =>
      withStartedBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* take(backend);
          yield* take(backend);
          const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
          yield* harness.guidanceSent;
          yield* take(backend);
          yield* harness.rejectReplay(kind);
          expect(yield* take(backend)).toMatchObject({ type: "protocol_error" });
          expect(yield* Effect.flip(backend.controls.steer("No resend"))).toMatchObject({
            code: "steer_not_sent",
          });
          yield* Fiber.interrupt(caller);
        }),
      ),
    );

  it.effect(
    "activity never extends the watchdog, whose primary cause survives generic process exit",
    () =>
      withStartedBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* take(backend);
          yield* take(backend);
          const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
          yield* harness.guidanceSent;
          yield* take(backend);
          yield* TestClock.adjust("299 seconds");
          yield* harness.activity;
          yield* take(backend);
          yield* take(backend);
          expect(harness.terminations()).toBe(0);
          yield* TestClock.adjust("1 second");
          yield* yieldUntil(() => harness.terminations() > 0);
          const exit = yield* backend.awaitExit;
          expect(exit.failure).toMatchObject({ code: "steer_outcome_uncertain" });
          // Watchdog closure is terminal uncertainty, never pending delivery.
          expect(exit.failure).not.toMatchObject({ pendingDelivery: true });
          expect(exit.failure?.message).toContain('"terminationReason":"steering-watchdog"');
          expect(exit.failure?.message).toContain('"activeToolCategory":"shell"');
          expect(exit.failure?.message).toContain('"lastInboundAgeMillis":1000');
          expect(exit.failure?.message).toContain('"cliVersion":"2.1.259"');
          expect(exit.failure?.message).not.toContain("private-tool-id");
          expect(exit.failure?.message).not.toContain("private command");
          expect(Exit.isFailure(yield* Fiber.await(caller))).toBe(true);
        }),
      ),
  );

  for (const path of ["forwarded", "watchdog-query", "transport-close"] as const)
    it.effect(
      `preserves exact accepted report through ${path} without claiming guidance incorporation`,
      () =>
        withStartedBackend("steering", 12, (backend, harness) =>
          Effect.gen(function* () {
            yield* take(backend);
            yield* take(backend);
            const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
            yield* harness.guidanceSent;
            yield* take(backend);
            yield* TestClock.adjust("11 seconds");
            expect(Exit.isFailure(yield* Fiber.await(caller))).toBe(true);
            yield* harness.acceptReport(12, path === "forwarded");
            if (path === "watchdog-query") yield* TestClock.adjust("289 seconds");
            if (path === "transport-close") yield* harness.close;
            expect(yield* take(backend)).toMatchObject({
              type: "input_delivery",
              state: "report-unconfirmed",
            });
            expect(yield* take(backend)).toMatchObject({
              type: "report",
              assignmentEpoch: 12,
              text: "Completed assignment",
            });
            expect(harness.terminations()).toBe(0);
            yield* TestClock.adjust("5 minutes");
            expect(harness.terminations()).toBe(0);
          }),
        ),
    );

  for (const settlement of ["report", "transport-close"] as const)
    it.effect(`${settlement} before the caller deadline never reports guidance pending`, () =>
      withStartedBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* take(backend);
          yield* take(backend);
          const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
          yield* harness.guidanceSent;
          yield* take(backend);
          if (settlement === "report") yield* harness.acceptReport(12);
          else yield* harness.close;
          const failure = yield* Effect.flip(Fiber.join(caller));
          expect(failure._tag).toBe("SubagentProcessError");
          expect(failure).not.toMatchObject({ pendingDelivery: true });
          if (settlement === "report")
            expect(failure).toMatchObject({ operation: "steer", code: "steer_outcome_uncertain" });
        }),
      ),
    );

  it.effect("a report for another assignment cannot suppress the steering watchdog", () =>
    withStartedBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
        yield* harness.guidanceSent;
        yield* take(backend);
        yield* harness.acceptReport(13, false);
        yield* TestClock.adjust("5 minutes");
        yield* yieldUntil(() => harness.terminations() > 0);
        expect((yield* backend.awaitExit).failure?.code).toBe("steer_outcome_uncertain");
        yield* Fiber.await(caller);
      }),
    ),
  );
});

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
        expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "pending" });
        yield* Fiber.interrupt(caller);
        yield* replayGuidance;
        expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "confirmed" });
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

describe("local Claude task-notification replays", () => {
  it.effect.each([
    ["one labelled replay", 1],
    ["more labelled replays than the result window", SENT_UUID_LIMIT + 1],
  ] as const)("tolerates %s mid-run and still completes the assignment", ([, count]) =>
    withStartedBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        expect(yield* take(backend)).toMatchObject({ type: "run_started", assignmentEpoch: 12 });
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          assignmentEpoch: 12,
        });
        for (let index = 0; index < count; index += 1) {
          yield* harness.taskNotification("labelled");
          expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        }
        // The assignment's own result still correlates to the adapter-sent input.
        yield* harness.assignmentResult;
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          assignmentEpoch: 12,
          usage: expect.objectContaining({ cost: 0.001 }),
        });
        yield* harness.acceptReport(12);
        expect(yield* take(backend)).toMatchObject({
          type: "report",
          assignmentEpoch: 12,
          text: "Completed assignment",
        });
        expect(harness.terminations()).toBe(0);
      }),
    ),
  );

  it.effect("suppresses a repeated labelled replay without owning another subturn", () =>
    withStartedBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        const uuid = yield* harness.taskNotification("labelled");
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        yield* harness.taskNotification("labelled", uuid);
        yield* harness.assignmentResult;
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          usage: expect.objectContaining({ cost: 0.001 }),
        });
      }),
    ),
  );

  it.effect("never lets a labelled replay confirm or displace pending guidance", () =>
    withStartedBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
        yield* harness.guidanceSent;
        expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "pending" });
        yield* harness.taskNotification("labelled");
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        expect(yield* Effect.flip(backend.controls.steer("Another guidance"))).toMatchObject({
          code: "steer_not_sent",
        });
        yield* harness.replayGuidance;
        expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "confirmed" });
        yield* Fiber.join(caller);
      }),
    ),
  );

  it.effect("keeps the unlabelled envelope fail closed while guidance is pending", () =>
    withStartedBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
        yield* harness.guidanceSent;
        yield* take(backend);
        yield* harness.taskNotification("unlabelled");
        expect(yield* take(backend)).toMatchObject({
          type: "protocol_error",
          message: expect.stringContaining("pending=steer"),
        });
        yield* Fiber.interrupt(caller);
      }),
    ),
  );

  it.effect.each(["labelled", "unlabelled"] as const)(
    "keeps a %s replay fail closed once the assignment result has settled",
    (form) =>
      withStartedBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* take(backend);
          yield* take(backend);
          yield* harness.assignmentResult;
          expect(yield* take(backend)).toMatchObject({
            type: "assistant_message",
            usage: expect.objectContaining({ cost: 0.001 }),
          });
          yield* harness.taskNotification(form);
          expect(yield* take(backend)).toMatchObject({ type: "protocol_error" });
        }),
      ),
  );

  it.effect.each([
    ["qualified", "subkind=peer-send-message"],
    ["untagged", "tag=none"],
    ["cross-session", "session=mismatch"],
    ["auto-continuation", "origin=auto-continuation"],
  ] as const)("rejects the %s near-miss replay", ([form, diagnostic]) =>
    withStartedBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* take(backend);
        yield* take(backend);
        yield* harness.taskNotification(form);
        expect(yield* take(backend)).toMatchObject({
          type: "protocol_error",
          message: expect.stringContaining(diagnostic),
        });
      }),
    ),
  );
});
