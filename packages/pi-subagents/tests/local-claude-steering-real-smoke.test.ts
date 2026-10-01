// Opt-in installed-CLI timing probe. This can incur provider usage; never retry it
// automatically. Capture `claude --version` separately before a live invocation.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { synchronousRandomHex, provideBuiltLayer } from "pi-cosmic-core";
import { describe, expect, it } from "vitest";
import { makeLocalClaudeBackendDriver } from "../src/backend/local-claude.ts";
import type { BackendEvent } from "../src/backend/model.ts";
import {
  makeLocalCliProcess,
  type LocalCliProcessContract,
} from "../src/boundary/local-cli-process.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../src/run/errors.ts";
import { backendLaunch } from "./fixtures/backend-supervisor.ts";

const sourceEnvironment = { ...process.env };
const enabled = sourceEnvironment.PI_SUBAGENTS_REAL_CLAUDE_STEERING_SMOKE === "1";
type Scenario = "tool" | "generation" | "native-agent";
const delayCommand = "sleep 25";
const guidanceMarker = "STEERING_OBSERVED";
const tasks = {
  tool: `Invoke Bash exactly once with command ${JSON.stringify(delayCommand)}, timeout 35000, and run_in_background false. Wait for it to finish, then submit your supervisor report.`,
  generation:
    "Without using tools first, write 120 numbered short factual sentences about integers. Do not abbreviate or summarize the list. Then submit your supervisor report.",
  "native-agent": [
    "Use the native Agent tool exactly once with run_in_background true to launch one read-only agent.",
    `Its entire task is one foreground Bash invocation with command ${JSON.stringify(delayCommand)}, timeout 35000, then a short final response.`,
    "Do not invoke Bash yourself. Collect its result with one blocking TaskOutput wait of at most 45000 ms, or its completion notification.",
    "Then submit your supervisor report. If Agent/background execution or result collection is unavailable, report that limitation promptly; do not substitute tools, poll, or retry.",
  ].join(" "),
} satisfies Record<Scenario, string>;

// Never serialize native errors, diagnostics, frames, tool arguments, or reports.
const failureCode = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    if (error instanceof SubagentProcessError || error instanceof InvalidSubagentRequestError)
      return error.code && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : "owned_error";
    if (Cause.isTimeoutError(error)) return "probe_timeout";
  }
  return Cause.hasDies(cause) ? "defect" : "interrupted";
};

// Deliberately not a shell parser: admit only fixed sleep forms, never arbitrary
// wrapper arguments, expansions, compound commands, or login-shell startup.
const delayCommands = new Set([
  delayCommand,
  "/bin/sleep 25",
  "command sleep 25",
  "exec sleep 25",
  ...["sh", "/bin/sh", "bash", "/bin/bash"].flatMap((shell) => [
    `${shell} -c '${delayCommand}'`,
    `${shell} -c "${delayCommand}"`,
  ]),
]);
const decodeBashArgs = Schema.decodeUnknownOption(
  Schema.Struct({
    command: Schema.String,
    run_in_background: Schema.optional(Schema.Boolean),
  }),
);
const classifyBash = (event: Extract<BackendEvent, { readonly type: "tool_started" }>) => {
  const decoded = decodeBashArgs(event.args);
  return {
    delayCommand: Option.isSome(decoded) && delayCommands.has(decoded.value.command.trim()),
    background: Option.isSome(decoded) && decoded.value.run_in_background === true,
  };
};

type ToolCategory =
  | "bash"
  | "nativeAgent"
  | "taskOutput"
  | "toolSearch"
  | "supervisorReport"
  | "other";
const toolCategory = (name: string): ToolCategory => {
  switch (name) {
    case "Bash":
      return "bash";
    case "Agent":
    case "Task":
      return "nativeAgent";
    case "TaskOutput":
      return "taskOutput";
    case "ToolSearch":
      return "toolSearch";
    case "mcp__pi_subagents_supervisor__supervisor_submit_report":
      return "supervisorReport";
    default:
      return "other";
  }
};

interface ProbeObservation {
  scenario: Scenario;
  activityObserved: boolean;
  nativeAgentObserved: boolean;
  delayToolObserved: boolean;
  delayToolFinished: boolean;
  toolCategories: Record<ToolCategory, boolean>;
  bashOtherCommandObserved: boolean;
  bashBackgroundObserved: boolean;
  triggerAtMs: number | undefined;
  steerCalls: number;
  steerRequestedAtMs: number | undefined;
  steerOutboundPreparedAtMs: number | undefined;
  steerReplayAtMs: number | undefined;
  steerReplayAfterUncertainCall: boolean;
  steerSettledAtMs: number | undefined;
  steerOutcome: string;
  steeringDelivery: Extract<BackendEvent, { readonly type: "input_delivery" }>["state"] | undefined;
  reportReceived: boolean;
  reportAtMs: number | undefined;
  reportEpochValid: boolean;
  reportNonempty: boolean;
  reportMentionsGuidance: boolean;
  protocolErrors: number;
  warnings: number;
  toolFailures: number;
  nativeFailures: number;
  streamClosed: boolean;
  exitObserved: boolean;
  exitCode: number | null | undefined;
  backendEvents: number;
  traceDropped: number;
  trace: Array<{
    atMs: number;
    kind: "outbound-user" | "user-decision";
    operation: string;
    decision?: string;
  }>;
}

describe.skipIf(!enabled)("installed local Claude steering smoke", () => {
  it("observes requested activity before classifying steering replay and report evidence", () => {
    const model = sourceEnvironment.PI_SUBAGENTS_REAL_CLAUDE_MODEL;
    if (!model) throw new Error("Set PI_SUBAGENTS_REAL_CLAUDE_MODEL for the live steering smoke.");
    const selected = sourceEnvironment.PI_SUBAGENTS_REAL_CLAUDE_STEERING_SCENARIO ?? "tool";
    if (selected !== "tool" && selected !== "generation" && selected !== "native-agent")
      throw new Error("Select tool, generation, or native-agent for the steering smoke.");
    const scenario: Scenario = selected;
    const agentDirectory = getAgentDir();
    const toolCategories = {
      bash: false,
      nativeAgent: false,
      taskOutput: false,
      toolSearch: false,
      supervisorReport: false,
      other: false,
    };
    const observation: ProbeObservation = {
      scenario,
      activityObserved: false,
      nativeAgentObserved: false,
      delayToolObserved: false,
      delayToolFinished: false,
      toolCategories,
      bashOtherCommandObserved: false,
      bashBackgroundObserved: false,
      triggerAtMs: undefined,
      steerCalls: 0,
      steerRequestedAtMs: undefined,
      steerOutboundPreparedAtMs: undefined,
      steerReplayAtMs: undefined,
      steerReplayAfterUncertainCall: false,
      steerSettledAtMs: undefined,
      steerOutcome: "not_sent",
      steeringDelivery: undefined,
      reportReceived: false,
      reportAtMs: undefined,
      reportEpochValid: false,
      reportNonempty: false,
      reportMentionsGuidance: false,
      protocolErrors: 0,
      warnings: 0,
      toolFailures: 0,
      nativeFailures: 0,
      streamClosed: false,
      exitObserved: false,
      exitCode: undefined,
      backendEvents: 0,
      traceDropped: 0,
      trace: [],
    };
    const program = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const elapsed = Clock.currentTimeMillis.pipe(Effect.map((now) => now - startedAt));
      // Override only this invocation's environment; no config or raw CLI debug file.
      const processes = makeLocalCliProcess({
        agentDirectory,
        environment: { ...sourceEnvironment, PI_SUBAGENTS_CLAUDE_DEBUG: "0" },
      });
      const traced: LocalCliProcessContract = {
        ...processes,
        spawn: (request) =>
          processes.spawn(request).pipe(
            Effect.map((child) => ({
              ...child,
              claudeDebug: {
                record: (entry) =>
                  Effect.gen(function* () {
                    const atMs = yield* elapsed;
                    // This hook is before send, not evidence that stdin accepted the frame.
                    if (entry.kind === "outbound-user" && entry.operation === "steer")
                      observation.steerOutboundPreparedAtMs = atMs;
                    if (
                      entry.kind === "user-decision" &&
                      entry.decision === "pending-confirmation" &&
                      entry.pending === "steer" &&
                      entry.epoch === 1 &&
                      entry.session === "match" &&
                      entry.uuid === "pending"
                    ) {
                      observation.steerReplayAtMs = atMs;
                      observation.steerReplayAfterUncertainCall =
                        observation.steerOutcome === "steer_outcome_uncertain";
                    }
                    if (entry.kind === "outbound-user" || entry.kind === "user-decision") {
                      if (observation.trace.length === 96) observation.traceDropped += 1;
                      else
                        observation.trace.push({
                          atMs,
                          kind: entry.kind,
                          operation:
                            entry.kind === "outbound-user" ? entry.operation : entry.pending,
                          ...(entry.kind === "user-decision" && { decision: entry.decision }),
                        });
                    }
                    yield* child.claudeDebug?.record(entry) ?? Effect.void;
                  }),
              },
            })),
          ),
      };
      const supervisors = yield* SupervisorChannel;
      const driver = makeLocalClaudeBackendDriver(traced, supervisors);
      const launch = backendLaunch({
        runId: `real-steering-${synchronousRandomHex(4)}`,
        parentSessionId: `real-steering-${process.pid}`,
        name: "real-local-claude-steering",
        model,
        effort: "low",
        systemPrompt: [
          "This is a bounded read-only timing probe. Do not edit files, change configuration, access the network, or retry tools.",
          "Follow the single requested scenario. Parent guidance may arrive while you work; do not wait for it before beginning.",
          "After the bounded work (or an unavailable-tool limitation), call mcp__pi_subagents_supervisor__supervisor_submit_report exactly once with a short report.",
        ].join(" "),
      });
      yield* driver.preflight(launch);
      const backend = yield* driver.spawn(launch);
      const activity = yield* Deferred.make<boolean>();
      const finished = yield* Deferred.make<void>();
      let delayToolId: string | undefined;
      let delayActive = false;
      let sawTool = false;
      let terminal = false;
      const consume = (event: BackendEvent) =>
        Effect.gen(function* () {
          // Drain and release raw ownership even while initialize/start/steer is waiting.
          backend.acknowledge(event);
          observation.backendEvents += 1;
          const atMs = yield* elapsed;
          if (event.type === "native_agent_activity" && event.assignmentEpoch === 1) {
            if (event.kind === "Agent" && event.state === "running")
              observation.nativeAgentObserved = true;
            if (event.state === "failed") observation.nativeFailures += 1;
          }
          if (event.type === "tool_started" && event.assignmentEpoch === 1) {
            sawTool = true;
            observation.toolCategories[toolCategory(event.toolName)] = true;
            if (event.toolName === "Bash") {
              const bash = classifyBash(event);
              if (!bash.delayCommand) observation.bashOtherCommandObserved = true;
              if (bash.background) observation.bashBackgroundObserved = true;
              if (bash.delayCommand && !bash.background) {
                observation.delayToolObserved = true;
                delayToolId = event.toolCallId;
                delayActive = true;
              }
            }
          }
          if (event.type === "tool_finished") {
            if (event.isError) observation.toolFailures += 1;
            if (event.toolCallId === delayToolId) {
              delayActive = false;
              observation.delayToolFinished = true;
            }
          }
          // Normalized activity is stream evidence, not proof of a particular token.
          const generationActive =
            event.type === "activity" && event.assignmentEpoch === 1 && !sawTool;
          const eligible =
            scenario === "generation"
              ? generationActive
              : delayActive && (scenario === "tool" || observation.nativeAgentObserved);
          if (eligible && !terminal && !observation.activityObserved) {
            observation.activityObserved = true;
            observation.triggerAtMs = atMs;
            yield* Deferred.succeed(activity, true);
          }
          if (event.type === "input_delivery" && event.assignmentEpoch === 1)
            observation.steeringDelivery = event.state;
          if (event.type === "warning") observation.warnings += 1;
          if (event.type === "protocol_error" || event.type === "backend_failure")
            observation.protocolErrors += 1;
          if (event.type === "report") {
            observation.reportReceived = true;
            observation.reportAtMs = atMs;
            // Backend report events are accepted supervisor reports, not assistant text.
            observation.reportEpochValid =
              event.assignmentEpoch === 1 && event.runId === launch.runId;
            observation.reportNonempty = Boolean(event.text?.trim());
            // A report alone is not evidence that guidance was applied.
            observation.reportMentionsGuidance = event.text?.includes(guidanceMarker) ?? false;
            terminal = true;
            yield* Deferred.succeed(activity, false);
            yield* Deferred.succeed(finished, undefined);
          }
        });
      yield* Stream.fromQueue(backend.events).pipe(
        Stream.runForEach(consume),
        Effect.tap(() =>
          Effect.sync(() => {
            observation.streamClosed = true;
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            terminal = true;
            yield* Deferred.succeed(activity, false);
            yield* Deferred.succeed(finished, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* backend.awaitExit.pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            observation.exitObserved = true;
            observation.exitCode = exit.exitCode;
          }),
        ),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* backend.controls.initialize;
      yield* backend.controls.start(tasks[scenario], 1);
      const observed = yield* Deferred.await(activity);
      // Let the already-observed tool enter execution; never send on a mere timer.
      if (observed && scenario !== "generation") yield* Effect.sleep("1 second");
      if (observed && !terminal && (scenario === "generation" || delayActive)) {
        observation.steerCalls += 1;
        observation.steerRequestedAtMs = yield* elapsed;
        observation.steerOutcome = "pending";
        yield* backend.controls
          .steer(
            `Complete the already-started bounded work without new tasks or retries. Include ${guidanceMarker} in your final supervisor report to acknowledge this guidance.`,
          )
          .pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                observation.steerSettledAtMs = yield* elapsed;
                observation.steerOutcome = Exit.isSuccess(exit)
                  ? "confirmed"
                  : failureCode(exit.cause);
              }),
            ),
            // Preserve report/closure evidence after uncertainty; never resend guidance.
            Effect.exit,
          );
      }
      yield* Deferred.await(finished);
    }).pipe(
      // Timeout is INSIDE the scope, so interruption still joins owned cleanup.
      Effect.timeout("120 seconds"),
      Effect.scoped,
      provideBuiltLayer(SupervisorChannel.layer({ agentDirectory })),
      Effect.exit,
    );
    return Effect.runPromise(
      program.pipe(
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            const failed = Exit.isFailure(exit) ? failureCode(exit.cause) : undefined;
            const replayDelayMs =
              observation.steerReplayAtMs !== undefined &&
              observation.steerOutboundPreparedAtMs !== undefined
                ? observation.steerReplayAtMs - observation.steerOutboundPreparedAtMs
                : undefined;
            const inconclusive =
              !failed &&
              observation.reportReceived &&
              observation.protocolErrors === 0 &&
              observation.steerCalls === 0;
            const acceptedReport =
              observation.reportReceived &&
              observation.reportEpochValid &&
              observation.reportNonempty;
            const lateReplayAfterUncertainty =
              observation.steerOutcome === "steer_outcome_uncertain" &&
              observation.steerReplayAfterUncertainCall;
            const replayAndReportObserved =
              acceptedReport &&
              observation.steerReplayAtMs !== undefined &&
              (observation.steerOutcome === "confirmed" || lateReplayAfterUncertainty);
            // Completion is a separate outcome: this state explicitly denies confirmation
            // of guidance rather than treating a report as an acknowledgement.
            const completedWithUnconfirmedGuidance =
              acceptedReport &&
              observation.steerOutcome === "steer_outcome_uncertain" &&
              observation.steerReplayAtMs === undefined &&
              observation.steeringDelivery === "report-unconfirmed";
            const metadata = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              ...observation,
              failure: failed,
              replayDelayMs,
              replayDelayedBeyondTenSeconds:
                replayDelayMs === undefined ? undefined : replayDelayMs > 10_000,
              lateReplayAfterUncertainty,
              replayAndReportObserved,
              completedWithUnconfirmedGuidance,
              inconclusive,
            });
            yield* Effect.logInfo("Local Claude steering smoke (metadata only)", metadata);
            // Runtime skip can discard evidence; an inconclusive probe is visibly non-passing.
            expect(
              inconclusive,
              `INCONCLUSIVE requested activity missing; metadata: ${metadata}`,
            ).toBe(false);
            expect(failed, `Probe or owned cleanup failed; metadata: ${metadata}`).toBeUndefined();
            expect(observation.steerCalls, metadata).toBe(1);
            expect(
              replayAndReportObserved || completedWithUnconfirmedGuidance,
              `Missing classified steering/report evidence; metadata: ${metadata}`,
            ).toBe(true);
            expect(observation.protocolErrors, metadata).toBe(0);
          }),
        ),
      ),
    );
  }, 150_000);
});
