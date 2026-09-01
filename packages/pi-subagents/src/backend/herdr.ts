import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { HerdrAgent } from "../boundary/herdr-cli.ts";
import type { HerdrHostContract, HerdrHostedAgent } from "../boundary/herdr-host.ts";
import type {
  SupervisorChannelHandle,
  SupervisorChannelContract,
} from "../boundary/supervisor-channel.ts";
import {
  isOutcomeUncertain,
  processError,
  SubagentProcessError,
  type SubagentError,
} from "../run/errors.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import { herdrAssignmentEpochLine } from "./herdr-assignment.ts";
import { unsupported as unsupportedCapability } from "./driver-shared.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "./model.ts";

const EVENT_CAPACITY = 256;
const RECONCILE_INTERVAL = "500 millis";
const MISSING_REPORT_POLLS = 10;
const PROMPT_EVIDENCE_POLLS = 10;
/** Bounded grace for sustained `unknown` agent status after a confirmed start. */
const UNKNOWN_STATUS_POLLS = 20;

const unsupported = (runtime: SubagentRuntime, capability: string) =>
  unsupportedCapability(
    `herdr/${runtime}`,
    capability,
    `The supported Herdr CLI contract does not provide a confirmable ${capability} outcome for ${runtime}.`,
  );

/** Fixed supervisor/report contract shared by all three Herdr native harnesses. */
export const withHerdrSupervisorInstructions = (
  runtime: SubagentRuntime,
  request: BackendLaunchRequest,
): BackendLaunchRequest => ({
  ...request,
  systemPrompt: [
    request.systemPrompt,
    "You are a session-scoped Herdr-hosted subagent. Delegate only through package-owned authenticated subagent proxies or native agent controls explicitly enabled by this runtime. Do not use unowned integrations, plugins, apps, hooks, skills, browser automation, remote control, or competing orchestration tools.",
    `Use only the private ${SUPERVISOR_MCP_REGISTRATION} tools for parent communication: ${SUPERVISOR_MCP_TOOL_NAMES.join(", ")}. The generic contact_parent instruction refers to these tools.`,
    `${SUPERVISOR_MCP_TOOL_NAMES[3]} is the only completion signal. Submit exactly one complete bounded report for each assignment with a fresh stable delivery_id. Raw assistant text and native idle/done status never complete the run.`,
    request.writeIntent === "read-only"
      ? runtime === "pi"
        ? "Read-only intent is a behavioral coordination policy, not a Pi tool restriction. Inherited Pi tools remain available, but Pi does not provide a filesystem sandbox: use them only for inspection and validation, do not mutate project files or run destructive commands, and use a writer assignment for intentional project changes."
        : "Read-only Bash is available for inspection and validation inside the runtime's strict filesystem sandbox. Do not attempt to mutate project files or bypass the sandbox; use a writer assignment for intentional project changes."
      : "Writer intent permits only assigned-cwd changes through the fixed runtime policy. Keep edits narrowly within the assignment.",
  ].join("\n\n"),
});

const assignmentPrompt = (runtime: SubagentRuntime, message: string, epoch: number): string =>
  [
    herdrAssignmentEpochLine(epoch),
    message,
    runtime === "pi"
      ? `Use ${SUPERVISOR_MCP_TOOL_NAMES.join(", ")} for parent communication.`
      : `Use only the ${SUPERVISOR_MCP_REGISTRATION} MCP tools for parent communication.`,
    `When complete, call ${SUPERVISOR_MCP_TOOL_NAMES[3]} exactly once with a fresh delivery_id. Do not treat native final text as delivery.`,
  ].join("\n\n");

const makeHandle = Effect.fn("HerdrBackend.makeHandle")(function* (
  runtime: SubagentRuntime,
  request: BackendLaunchRequest,
  hosted: HerdrHostedAgent,
  supervisor: SupervisorChannelHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const exited = yield* Deferred.make<
    Extract<BackendEvent, { readonly type: "exit" }>,
    SubagentError
  >();
  let preparedEpoch = 0;
  let promptIssuingEpoch = 0;
  let confirmedStartedEpoch = 0;
  let reconcilingEpoch = 0;
  let missingReportPolls = 0;
  let unknownStatusPolls = 0;
  let closed = false;

  const offer = (event: BackendEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const finish = (diagnostic: string, exitCode: number | null = null) =>
    Effect.sync(() => {
      if (closed) return;
      closed = true;
      const exit = { type: "exit" as const, exitCode, diagnostic };
      Queue.endUnsafe(events);
      Deferred.doneUnsafe(exited, Effect.succeed(exit));
    });
  const cancelPending = (error: SubagentError) => supervisor.cancelPending(error.message);

  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach((event) => offer(event)),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  let reconcile: Effect.Effect<void, never> = Effect.void;
  reconcile = Effect.suspend(() => {
    if (closed) return Effect.void;
    return hosted.inspect.pipe(
      Effect.flatMap((remote) => {
        if (confirmedStartedEpoch <= 0) {
          missingReportPolls = 0;
          unknownStatusPolls = 0;
          return Effect.void;
        }
        if (
          remote.agentStatus !== "unknown" &&
          remote.agentStatus !== "idle" &&
          remote.agentStatus !== "done"
        ) {
          unknownStatusPolls = 0;
          missingReportPolls = 0;
          return Effect.void;
        }
        // Accepted report ownership wins before terminal/unknown topology checks.
        // This is essential for retained runs: their backend remains alive after a
        // successful report and later observability loss must not overwrite it.
        return supervisor.hasAcceptedReport(confirmedStartedEpoch).pipe(
          Effect.flatMap((accepted) => {
            if (accepted) {
              unknownStatusPolls = 0;
              missingReportPolls = 0;
              return Effect.void;
            }
            if (remote.agentStatus === "unknown") {
              // Sustained unobservable status without a causal report fails closed;
              // transient unknown does not erase existing missing-report evidence.
              unknownStatusPolls += 1;
              if (unknownStatusPolls < UNKNOWN_STATUS_POLLS) return Effect.void;
              return offer({
                type: "protocol_error",
                message: `${runtime} agent status in Herdr remained unknown beyond the bounded observation grace after a confirmed start.`,
              }).pipe(
                Effect.andThen(
                  finish(`${runtime} agent status in Herdr remained unobservable after start.`),
                ),
              );
            }
            unknownStatusPolls = 0;
            missingReportPolls += 1;
            if (missingReportPolls < MISSING_REPORT_POLLS) return Effect.void;
            return offer({
              type: "protocol_error",
              message: `${runtime} settled in Herdr without an accepted supervisor report.`,
            }).pipe(
              Effect.andThen(
                finish(`${runtime} settled in Herdr without an accepted supervisor report.`),
              ),
            );
          }),
        );
      }),
      Effect.catch((error) =>
        offer({
          type: "protocol_error",
          message: `Herdr ownership/topology reconciliation failed closed: ${error.message}`,
        }).pipe(
          Effect.andThen(
            finish("Herdr agent ownership/topology evidence is missing or mismatched."),
          ),
        ),
      ),
      Effect.andThen(Effect.sleep(RECONCILE_INTERVAL)),
      Effect.andThen(reconcile),
    );
  });
  yield* reconcile.pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      cancelPending(
        processError("close", "herdr_backend_closed", `Herdr ${runtime} backend closed.`),
      );
      if (!closed) {
        closed = true;
        Queue.endUnsafe(events);
        Deferred.doneUnsafe(
          exited,
          Effect.succeed({
            type: "exit",
            exitCode: null,
            diagnostic: "Herdr backend scope closed.",
          }),
        );
      }
    }),
  );

  const initialize = Effect.gen(function* () {
    const remote = yield* hosted.inspect;
    yield* supervisor.awaitReady.pipe(
      Effect.mapError((error) => processError("initialize", error.code, error.message)),
    );
    return {
      model: request.model,
      effort: request.effort,
      sessionId: `herdr:${remote.terminalId}`,
    };
  });

  const terminate = (_mode: "graceful" | "force") =>
    hosted.close.pipe(
      Effect.andThen(finish("Session-owned Herdr pane closed by parent.")),
      Effect.mapError((error) =>
        processError("close Herdr agent", error.code ?? "herdr_cleanup_unconfirmed", error.message),
      ),
    );

  const confirmStarted = (epoch: number) =>
    Effect.sync(() => {
      preparedEpoch = epoch;
      promptIssuingEpoch = 0;
      confirmedStartedEpoch = epoch;
      reconcilingEpoch = 0;
      missingReportPolls = 0;
      unknownStatusPolls = 0;
    }).pipe(Effect.andThen(offer({ type: "run_started", assignmentEpoch: epoch })));

  const reconcilePromptEvidence = (
    epoch: number,
    baseline: HerdrAgent,
    remaining = PROMPT_EVIDENCE_POLLS,
  ): Effect.Effect<void, SubagentProcessError> =>
    Effect.suspend(() => {
      if (preparedEpoch !== epoch || promptIssuingEpoch !== epoch || reconcilingEpoch !== epoch)
        return Effect.fail(
          processError(
            "start",
            "herdr_prompt_cleanup_unconfirmed",
            "Herdr uncertain-prompt reconciliation lost assignment ownership.",
          ),
        );
      return supervisor.hasAcceptedReport(epoch).pipe(
        Effect.mapError((error) => processError("start", error.code, error.message)),
        Effect.flatMap((accepted) => {
          if (accepted) return confirmStarted(epoch);
          return hosted.inspect.pipe(
            Effect.mapError((error) =>
              processError(
                "start",
                "herdr_prompt_cleanup_unconfirmed",
                `Herdr prompt reconciliation lost exact ownership evidence: ${error.message}`,
              ),
            ),
            Effect.flatMap((remote) => {
              const changed =
                remote.stateChangeSequence > baseline.stateChangeSequence ||
                remote.agentStatus !== baseline.agentStatus ||
                remote.interactiveReady !== baseline.interactiveReady;
              if (changed) return confirmStarted(epoch);
              if (remaining <= 1) {
                const error = processError(
                  "start",
                  "herdr_prompt_outcome_uncertain",
                  "Herdr prompt delivery remained uncertain without a causal accepted report or bounded post-prompt topology/state-change evidence.",
                );
                promptIssuingEpoch = 0;
                reconcilingEpoch = 0;
                return offer({ type: "protocol_error", message: error.message }).pipe(
                  Effect.andThen(finish("Herdr prompt evidence expired without causal execution.")),
                  Effect.andThen(Effect.fail(error)),
                );
              }
              return Effect.sleep(RECONCILE_INTERVAL).pipe(
                Effect.andThen(reconcilePromptEvidence(epoch, baseline, remaining - 1)),
              );
            }),
          );
        }),
      );
    });

  return {
    events,
    awaitExit: Deferred.await(exited),
    controls: {
      initialize,
      start: (message: string, epoch: number) =>
        Effect.gen(function* () {
          yield* supervisor
            .setAssignmentEpoch(epoch)
            .pipe(Effect.mapError((error) => processError("start", error.code, error.message)));
          preparedEpoch = epoch;
          missingReportPolls = 0;
          unknownStatusPolls = 0;
          const baseline = yield* hosted.inspect;
          promptIssuingEpoch = epoch;
          const prompt = yield* hosted.prompt(assignmentPrompt(runtime, message, epoch)).pipe(
            Effect.catch((error) => {
              if (isOutcomeUncertain(error)) return Effect.void;
              promptIssuingEpoch = 0;
              reconcilingEpoch = 0;
              return Effect.fail(error);
            }),
          );
          // Herdr 0.8 responds after queueing text and scheduling delayed Enter. The
          // response is dispatch evidence, not proof that the assignment executed.
          reconcilingEpoch = epoch;
          yield* reconcilePromptEvidence(epoch, prompt ?? baseline);
        }),
      steer: (_message: string) => Effect.fail(unsupported(runtime, "steer")),
      interrupt: Effect.fail(unsupported(runtime, "interrupt")),
      renameDisplay: () => Effect.fail(unsupported(runtime, "rename-display")),
      reply: (requestId: string, message: string) =>
        supervisor
          .reply(requestId, message)
          .pipe(Effect.mapError((error) => processError("reply", error.code, error.message))),
      notifyPeers: () => Effect.fail(unsupported(runtime, "peer-notice")),
      deliverNotification:
        runtime === "pi"
          ? (message: string) =>
              supervisor
                .deliverNotification(message)
                .pipe(
                  Effect.mapError((error) =>
                    processError("deliver notification", error.code, error.message),
                  ),
                )
          : undefined,
    },
    acknowledge: () => {},
    terminate,
    cancelPending,
  };
});

export const makeHerdrBackendDriver = (
  runtime: SubagentRuntime,
  host: HerdrHostContract,
  supervisors: SupervisorChannelContract,
): BackendDriver => ({
  host: "herdr",
  runtime,
  capabilities: ["parent-contact"],
  supportsContext: (context) => context === "fresh",
  preflight: (request) => host.preflight({ runtime, ...request }),
  spawn: (request) =>
    Effect.gen(function* () {
      const launch = withHerdrSupervisorInstructions(runtime, request);
      const supervisor = yield* supervisors
        .open({ runId: request.runId, allowPiProxy: runtime === "pi" })
        .pipe(
          Effect.mapError((error) =>
            processError("open Herdr supervisor channel", error.code, error.message),
          ),
        );
      const hosted = yield* host.launch(runtime, launch, supervisor.metadata);
      return yield* makeHandle(runtime, launch, hosted, supervisor);
    }),
});
