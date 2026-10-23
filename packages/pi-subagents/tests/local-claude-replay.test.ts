import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { localClaudeBackendDriver } from "../src/backend/local-claude.ts";
import { SENT_UUID_LIMIT } from "../src/backend/local-claude-correlation.ts";
import {
  type ClaudeControlRequestFrame,
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
import { objectContaining, stringContaining } from "./support/matchers.ts";
import { OVERSIZED_IMAGE_DATA, oversizedLine } from "./support/oversized-line.ts";

const wireJson = Schema.decodeUnknownSync(Schema.Json);
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

type TaskNotificationReplay =
  | "labelled"
  | "unlabelled"
  | "qualified"
  | "untagged"
  | "cross-session"
  | "auto-continuation";

interface RunningTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cost: number;
}

const modelUsage = (inputTokens: number, outputTokens: number, cacheReadInputTokens: number) => ({
  "fixture-model": {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens: 0,
  },
});

const TASK_NOTIFICATION =
  "<task-notification><task-id>background-shell</task-id><status>completed</status><summary>Background command completed.</summary></task-notification>";

interface ReplayHarness {
  readonly processes: LocalCliProcessContract;
  readonly supervisors: SupervisorChannelContract;
  readonly guidanceSent: Effect.Effect<void>;
  readonly replayGuidance: Effect.Effect<void>;
  readonly taskNotification: (form: TaskNotificationReplay, uuid?: string) => Effect.Effect<string>;
  readonly assignmentResult: (finalText?: string) => Effect.Effect<void>;
  readonly sentTexts: () => ReadonlyArray<string>;
  readonly backgroundTasks: (count: number) => Effect.Effect<void>;
  readonly requireReports: Effect.Effect<void>;
  readonly taskCompleted: Effect.Effect<void>;
  readonly peerMessage: Effect.Effect<void>;
  readonly continuationResult: (
    userMessageUuid?: string,
    totals?: RunningTotals,
  ) => Effect.Effect<void>;
  readonly foreignResult: Effect.Effect<void>;
  readonly rejectReplay: (
    kind: "wrong-uuid" | "wrong-session" | "absent-session",
  ) => Effect.Effect<void>;
  readonly acceptReport: (epoch: number, forward?: boolean) => Effect.Effect<void>;
  readonly activity: Effect.Effect<void>;
  readonly oversized: (event: ClaudeInboundFrame) => Effect.Effect<void>;
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
    // Most scenarios assume the report was accepted; strict ones check the actual report.
    let strictReports = false;
    const guidanceSent = Deferred.makeUnsafe<void>();
    const exited = Deferred.makeUnsafe<{ exitCode: number; stderr: string }>();
    let terminations = 0;
    const sentTexts: string[] = [];
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
      Queue.offerUnsafe(childEvents, { type: "message", value: wireJson(value) });
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
    const answerControlRequest = (outbound: ClaudeControlRequestFrame) => {
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
                  name: SUPERVISOR_MCP_REGISTRATION,
                  status: "connected",
                  tools: SUPERVISOR_MCP_TOOL_NAMES.map((name) => ({ name })),
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
    };
    const queuedNotificationScenarios: ReadonlySet<ReplayScenario> = new Set([
      "queued-task-notification",
      "queued-task-notification-duplicate",
      "queued-task-notification-cross-session",
      "tagged-task-notification-nonreplay",
      "tagged-task-notification-channel",
    ]);
    const offerQueuedNotification = () => {
      if (!queuedNotificationScenarios.has(scenario)) return;
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
    };
    const offerNotificationFrames = () => {
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
      offerQueuedNotification();
    };
    const offerReplayFrames = (outbound: ClaudeUserFrame) => {
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
    };
    const offerScenarioFrames = (outbound: ClaudeUserFrame) => {
      offerReplayFrames(outbound);
      offerNotificationFrames();
    };
    const offerTurnResult = (outbound: ClaudeUserFrame) => {
      const result: ClaudeInboundFrame = {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "claude-replay-session",
        user_message_uuid: outbound.uuid,
        ...(scenario !== "accepted-report-cost-only" && { modelUsage: modelUsage(5, 4, 1) }),
        total_cost_usd: 0.001,
      };
      if (
        (scenario === "accepted-report-result" || scenario === "accepted-report-cost-only") &&
        acceptedReport
      ) {
        pendingResult = result;
        Queue.offerUnsafe(supervisorEvents, { type: "report", ...acceptedReport });
        Queue.offerUnsafe(supervisorEvents, {
          type: "supervisor_contact",
          assignmentEpoch: 12,
          requestId: "after-report",
          kind: "progress",
          message: "Native finalization pending",
        });
      } else offerChild(result);
    };
    const send = (outbound: LocalCliOutboundFrame) =>
      Effect.sync(() => {
        if (!("type" in outbound)) return;
        if (outbound.type === "control_request") return answerControlRequest(outbound);
        if (outbound.type !== "user") return;
        sentTexts.push(outbound.message.content);
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
        offerScenarioFrames(outbound);
        if (scenario === "accepted-report-close") return;
        offerTurnResult(outbound);
      });

    const child: LocalCliHandle = {
      pid: 1,
      events: childEvents,
      awaitExit: Deferred.await(exited),
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
            tools: SUPERVISOR_MCP_TOOL_NAMES.map(
              (tool) => `mcp__${SUPERVISOR_MCP_REGISTRATION}__${tool}`,
            ),
            mcp_servers: [{ name: SUPERVISOR_MCP_REGISTRATION, status: "connected" }],
          });
          return child;
        }),
    };
    const supervisors: SupervisorChannelContract = {
      open: () => {
        const handle = backendSupervisor(supervisorMetadata(), supervisorEvents, {
          hasAcceptedReport: (epoch) =>
            Effect.succeed(!strictReports || acceptedReport?.assignmentEpoch === epoch),
          acceptedReportForEpoch: (epoch) =>
            Effect.succeed(acceptedReport?.assignmentEpoch === epoch ? acceptedReport : undefined),
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
      oversized: (event) =>
        Effect.sync(() => {
          Queue.offerUnsafe(childEvents, {
            type: "oversized_line",
            ...oversizedLine(wireJson(event)),
          });
        }),
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
      peerMessage: Effect.sync(() =>
        offerChild({
          type: "user",
          uuid: "claude-peer-message",
          isReplay: true,
          isSynthetic: true,
          session_id: "claude-replay-session",
          origin: { kind: "peer" },
          message: { role: "user", content: "Message from the probe agent: count is 1." },
        }),
      ),
      taskCompleted: Effect.sync(() => {
        offerChild({
          type: "system",
          subtype: "task_notification",
          task_id: "task-0",
          session_id: "claude-replay-session",
        });
        offerChild({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
          session_id: "claude-replay-session",
        });
      }),
      requireReports: Effect.sync(() => {
        strictReports = true;
      }),
      backgroundTasks: (count) =>
        Effect.sync(() =>
          offerChild({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: Array.from({ length: count }, (_, index) => ({ task_id: `task-${index}` })),
            session_id: "claude-replay-session",
          }),
        ),
      continuationResult: (userMessageUuid, totals) =>
        Effect.sync(() =>
          offerChild({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "claude-replay-session",
            ...(userMessageUuid === undefined
              ? { origin: { kind: "task-notification" } }
              : { user_message_uuid: userMessageUuid }),
            ...(totals && {
              modelUsage: modelUsage(totals.input, totals.output, totals.cacheRead),
              total_cost_usd: totals.cost,
            }),
          }),
        ),
      assignmentResult: (finalText) =>
        Effect.sync(() =>
          offerChild({
            type: "result",
            subtype: "success",
            is_error: false,
            session_id: "claude-replay-session",
            user_message_uuid: assignmentUuid,
            ...(finalText !== undefined && { result: finalText }),
            modelUsage: modelUsage(5, 4, 1),
            total_cost_usd: 0.001,
          }),
        ),
      sentTexts: () => sentTexts,
      foreignResult: Effect.sync(() =>
        offerChild({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "different-claude-session",
          user_message_uuid: assignmentUuid,
          modelUsage: modelUsage(1000, 1000, 0),
          total_cost_usd: 100,
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
  use: (backend: BackendHandle, harness: ReplayHarness) => Effect.Effect<A, E, Scope.Scope>,
): Effect.Effect<A, E | SubagentError> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      makeReplayHarness(scenario),
      (harness) =>
        Effect.gen(function* () {
          const backend = yield* localClaudeBackendDriver(
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

const withRunningBackend = <A, E>(
  scenario: ReplayScenario,
  epoch: number,
  use: (backend: BackendHandle, harness: ReplayHarness) => Effect.Effect<A, E, Scope.Scope>,
) =>
  withStartedBackend(scenario, epoch, (backend, harness) =>
    Effect.gen(function* () {
      expect(yield* take(backend)).toMatchObject({ type: "run_started", assignmentEpoch: epoch });
      expect(yield* take(backend)).toMatchObject({
        type: "assistant_message",
        assignmentEpoch: epoch,
      });
      return yield* use(backend, harness);
    }),
  );

const sendDelayedGuidance = (backend: BackendHandle, harness: ReplayHarness) =>
  Effect.gen(function* () {
    const caller = yield* Effect.forkChild(backend.controls.steer("Delayed guidance"));
    yield* harness.guidanceSent;
    expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "pending" });
    return caller;
  });

const expectInternalUserFrame = (scenario: ReplayScenario) =>
  withRunningBackend(scenario, 8, (backend) =>
    Effect.gen(function* () {
      expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 8 });
      expect(yield* take(backend)).toMatchObject({
        type: "assistant_message",
        assignmentEpoch: 8,
        usage: objectContaining({ cost: 0.001 }),
      });
      expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
    }),
  );

// A turn that ends without a report earns one reminder turn; only that turn's miss fails.
const missReportAfterReminder = (
  backend: BackendHandle,
  harness: ReplayHarness,
  finalText?: string,
) =>
  Effect.gen(function* () {
    expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
    expect(yield* take(backend)).toMatchObject({ type: "assistant_message", text: "Working" });
    yield* harness.assignmentResult(finalText);
    expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
    return yield* take(backend);
  });

const takeRejectedUserFrame = (scenario: ReplayScenario) =>
  withRunningBackend(scenario, 9, (backend) => take(backend));

describe("local Claude steering acknowledgement lifecycle", () => {
  it.effect(
    "rejects a foreign result without consuming the assignment or accounting its usage",
    () =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* harness.foreignResult;
          expect(yield* take(backend)).toMatchObject({ type: "protocol_error" });
          yield* harness.assignmentResult();
          expect(yield* take(backend)).toMatchObject({
            type: "assistant_message",
            assignmentEpoch: 12,
            usage: {
              input: 2,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: 0.001,
            },
          });
          expect(Option.isNone(yield* Queue.poll(backend.events))).toBe(true);
        }),
      ),
  );
  it.effect(
    "survives the caller deadline, rejects new send and cancel_queued interrupt, then confirms late",
    () =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          const caller = yield* sendDelayedGuidance(backend, harness);
          yield* TestClock.adjust("11 seconds");
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

  for (const kind of ["wrong-session"] as const)
    it.effect(`does not confirm same-text guidance from ${kind}`, () =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          const caller = yield* sendDelayedGuidance(backend, harness);
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
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          const caller = yield* sendDelayedGuidance(backend, harness);
          yield* TestClock.adjust("299 seconds");
          yield* harness.activity;
          yield* take(backend);
          yield* take(backend);
          expect(harness.terminations()).toBe(0);
          yield* TestClock.adjust("1 second");
          yield* yieldUntil(() => harness.terminations() > 0);
          const exit = yield* backend.awaitExit;
          expect(exit.failure).toMatchObject({ code: "steer_outcome_uncertain" });
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

  for (const settlement of ["report", "transport-close"] as const)
    it.effect(`${settlement} before the caller deadline never reports guidance pending`, () =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          const caller = yield* sendDelayedGuidance(backend, harness);
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
    withRunningBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        const caller = yield* sendDelayedGuidance(backend, harness);
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
  it.effect.each([
    ["owns Claude command-queue task-notification replays", "queued-task-notification"],
  ] as const)("%s", ([, scenario]) => expectInternalUserFrame(scenario));

  it.effect.each([
    [
      "uses content matches only as evidence and never as replay authority",
      "same-content-foreign-replay",
      "content=assignment",
    ],
  ] as const)("%s", ([, scenario, diagnostic]) =>
    Effect.gen(function* () {
      expect(yield* takeRejectedUserFrame(scenario)).toMatchObject({
        type: "protocol_error",
        message: stringContaining(diagnostic),
      });
    }),
  );

  it.effect("keeps foreign top-level UUIDs fail closed with bounded diagnostics", () =>
    Effect.gen(function* () {
      const failure = yield* takeRejectedUserFrame("foreign-replay");
      expect(failure).toMatchObject({
        type: "protocol_error",
        message: stringContaining("uuid=present"),
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

  it.effect("keeps exact UUID replay correlated after guidance caller cancellation", () =>
    withRunningBackend("accepted-report-close", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(yield* sendDelayedGuidance(backend, harness));
        yield* harness.replayGuidance;
        expect(yield* take(backend)).toMatchObject({ type: "input_delivery", state: "confirmed" });
        expect(yield* take(backend)).toMatchObject({
          type: "assistant_message",
          text: "Guidance consumed",
        });
      }),
    ),
  );

  it.effect("preserves accepted evidence behind a full queue and delayed consumer", () =>
    withRunningBackend("accepted-report-close", 12, (backend, { close, fillProgress }) =>
      Effect.gen(function* () {
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
});

describe("local Claude task-notification replays", () => {
  it.effect.each([["more labelled replays than the result window", SENT_UUID_LIMIT + 1]] as const)(
    "tolerates %s mid-run and still completes the assignment",
    ([, count]) =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          for (let index = 0; index < count; index += 1) {
            yield* harness.taskNotification("labelled");
            expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
          }
          yield* harness.assignmentResult();
          expect(yield* take(backend)).toMatchObject({
            type: "assistant_message",
            assignmentEpoch: 12,
            usage: objectContaining({ cost: 0.001 }),
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

  it.effect("never lets a labelled replay confirm or displace pending guidance", () =>
    withRunningBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        const caller = yield* sendDelayedGuidance(backend, harness);
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

  it.effect(
    "waits for the continuation turn when background work outlives the assignment turn",
    () =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* harness.requireReports;
          yield* harness.backgroundTasks(1);
          expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
          yield* harness.assignmentResult();
          expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
          yield* harness.backgroundTasks(0);
          expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
          const notification = yield* harness.taskNotification("labelled");
          expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
          yield* harness.acceptReport(12);
          yield* harness.continuationResult(notification);
          expect(yield* take(backend)).toMatchObject({
            type: "report",
            assignmentEpoch: 12,
            text: "Completed assignment",
          });
        }),
      ),
  );

  it.effect("waits when a background task reported back just before the turn ended", () =>
    withRunningBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* harness.requireReports;
        yield* harness.backgroundTasks(1);
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        yield* harness.taskCompleted;
        // Both notification frames are activity; the second coalesces into the pending first.
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        yield* harness.assignmentResult();
        expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
        yield* harness.acceptReport(12);
        yield* harness.continuationResult();
        expect(yield* take(backend)).toMatchObject({ type: "report", assignmentEpoch: 12 });
      }),
    ),
  );

  it.effect("fails when no continuation follows a notification within the grace period", () =>
    withRunningBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* harness.requireReports;
        yield* harness.backgroundTasks(1);
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        yield* harness.taskCompleted;
        // Both notification frames are activity; the second coalesces into the pending first.
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        yield* harness.activity;
        expect(yield* take(backend)).toMatchObject({ type: "tool_started" });
        expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
        yield* harness.assignmentResult();
        expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
        yield* TestClock.adjust("21 seconds");
        expect(yield* missReportAfterReminder(backend, harness)).toMatchObject({
          type: "protocol_error",
          message: stringContaining("without an accepted supervisor report"),
        });
      }),
    ),
  );

  it.effect("closes a tool whose result line exceeds the transport limit", () =>
    withRunningBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* harness.activity;
        expect(yield* take(backend)).toMatchObject({
          type: "tool_started",
          toolCallId: "private-tool-id",
        });
        expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
        const image = { type: "base64", media_type: "image/png", data: OVERSIZED_IMAGE_DATA };
        yield* harness.oversized({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                tool_use_id: "private-tool-id",
                type: "tool_result",
                content: [{ type: "image", source: image }],
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: "claude-replay-session",
          uuid: "tool-result-uuid",
        });
        expect(yield* take(backend)).toMatchObject({
          type: "tool_finished",
          toolCallId: "private-tool-id",
          toolName: "Bash",
          isError: false,
        });
        yield* harness.oversized({ type: "stream_event", event: { delta: OVERSIZED_IMAGE_DATA } });
        expect(yield* take(backend)).toEqual({ type: "activity", assignmentEpoch: 12 });
        yield* harness.oversized({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: OVERSIZED_IMAGE_DATA }] },
        });
        expect(yield* take(backend)).toMatchObject({ type: "protocol_error" });
      }),
    ),
  );

  it.effect("reminds once, then fails with the reminded turn's final text", () =>
    withRunningBackend("steering", 12, (backend, harness) =>
      Effect.gen(function* () {
        yield* harness.requireReports;
        yield* harness.assignmentResult("Here is my answer, without a report.");
        expect(yield* take(backend)).toMatchObject({ type: "assistant_message" });
        const failure = yield* missReportAfterReminder(backend, harness, "Still no report.");
        expect(failure).toMatchObject({
          type: "protocol_error",
          message: stringContaining("even after a reminder"),
        });
        if (failure.type !== "protocol_error") return yield* Effect.die("Expected a failure.");
        expect(failure.message).toContain("Still no report.");
        expect(failure.message).not.toContain("Here is my answer");
        expect(harness.sentTexts().at(-1)).toContain("agent_submit_report");
        return undefined;
      }),
    ),
  );

  it.effect.each([["cross-session", "session=mismatch"]] as const)(
    "rejects the %s near-miss replay",
    ([form, diagnostic]) =>
      withRunningBackend("steering", 12, (backend, harness) =>
        Effect.gen(function* () {
          yield* harness.taskNotification(form);
          expect(yield* take(backend)).toMatchObject({
            type: "protocol_error",
            message: stringContaining(diagnostic),
          });
        }),
      ),
  );
});
