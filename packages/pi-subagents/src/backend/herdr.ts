import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { HerdrAgent } from "../boundary/herdr-cli.ts";
import { HerdrHost, type HerdrHostShape, type HerdrHostedAgent } from "../boundary/herdr-host.ts";
import {
  SupervisorChannel,
  type SupervisorChannelHandle,
  type SupervisorChannelShape,
} from "../boundary/supervisor-channel.ts";
import {
  SubagentProcessError,
  UnsupportedSubagentCapabilityError,
  type SubagentError,
} from "../run/errors.ts";
import type { SubagentRuntime } from "../run/model.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "./model.ts";

const EVENT_CAPACITY = 256;
const RECONCILE_INTERVAL = "500 millis";
const MISSING_REPORT_POLLS = 10;
const PROMPT_EVIDENCE_POLLS = 10;

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });
const unsupported = (runtime: SubagentRuntime, capability: string) =>
  new UnsupportedSubagentCapabilityError({
    backend: `herdr/${runtime}`,
    capability,
    message: `The supported Herdr CLI contract does not provide a confirmable ${capability} outcome for ${runtime}.`,
  });

/** Fixed supervisor/report contract shared by all three Herdr native harnesses. */
export const withHerdrSupervisorInstructions = (
  request: BackendLaunchRequest,
): BackendLaunchRequest => ({
  ...request,
  systemPrompt: [
    request.systemPrompt,
    "You are a session-scoped Herdr-hosted subagent. Never delegate, launch another agent, or use unowned integrations, plugins, apps, hooks, skills, browser automation, remote control, or orchestration tools.",
    "Use only the private pi_subagents_supervisor tools for parent communication: supervisor_progress, supervisor_warning, supervisor_question, and supervisor_submit_report. The generic contact_parent instruction refers to these tools.",
    "supervisor_submit_report is the only completion signal. Submit exactly one complete bounded report for each assignment with a fresh stable delivery_id. Raw assistant text and native idle/done status never complete the run.",
    request.writeIntent === "read-only"
      ? "Read-only is a fixed capability policy for Pi and Claude and a native read-only Codex sandbox. Do not mutate files or use a shell through Pi or Claude."
      : "Writer intent permits only assigned-cwd changes through the fixed runtime policy. Keep edits narrowly within the assignment.",
  ].join("\n\n"),
});

const assignmentPrompt = (runtime: SubagentRuntime, message: string, epoch: number): string =>
  [
    `Begin supervisor assignment epoch ${epoch}.`,
    message,
    runtime === "pi"
      ? "Use supervisor_progress, supervisor_warning, supervisor_question, and supervisor_submit_report for parent communication."
      : "Use only the pi_subagents_supervisor MCP tools for parent communication.",
    "When complete, call supervisor_submit_report exactly once with a fresh delivery_id. Do not treat native final text as delivery.",
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
        if (
          confirmedStartedEpoch <= 0 ||
          (remote.agentStatus !== "idle" && remote.agentStatus !== "done")
        ) {
          missingReportPolls = 0;
          return Effect.void;
        }
        return supervisor.hasAcceptedReport(confirmedStartedEpoch).pipe(
          Effect.flatMap((accepted) => {
            if (accepted) {
              missingReportPolls = 0;
              return Effect.void;
            }
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
              if (remaining <= 1)
                return Effect.fail(
                  processError(
                    "start",
                    "herdr_prompt_outcome_uncertain",
                    "Herdr prompt delivery remained uncertain without a causal accepted report or bounded post-prompt topology/state-change evidence.",
                  ),
                );
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
          const baseline = yield* hosted.inspect;
          promptIssuingEpoch = epoch;
          const prompt = yield* hosted
            .prompt(assignmentPrompt(runtime, message, epoch))
            .pipe(Effect.exit);
          if (prompt._tag === "Success") {
            // Herdr 0.8 responds after queueing text and scheduling delayed Enter. The
            // response is dispatch evidence, not proof that the assignment executed.
            reconcilingEpoch = epoch;
            yield* reconcilePromptEvidence(epoch, prompt.value);
            return;
          }
          const error = Cause.squash(prompt.cause);
          const processFailure =
            error &&
            typeof error === "object" &&
            "_tag" in error &&
            error._tag === "SubagentProcessError"
              ? (error as SubagentProcessError)
              : undefined;
          if (processFailure?.code?.endsWith("_outcome_uncertain")) {
            reconcilingEpoch = epoch;
            yield* reconcilePromptEvidence(epoch, baseline);
            return;
          }
          promptIssuingEpoch = 0;
          reconcilingEpoch = 0;
          return yield* (
            processFailure ??
              processError("start", "herdr_prompt_failed", "Herdr prompt delivery failed.")
          );
        }),
      steer: (_message: string) => Effect.fail(unsupported(runtime, "steer")),
      interrupt: Effect.fail(unsupported(runtime, "interrupt")),
      renameDisplay: () => Effect.fail(unsupported(runtime, "rename-display")),
      reply: (requestId: string, message: string) =>
        supervisor
          .reply(requestId, message)
          .pipe(Effect.mapError((error) => processError("reply", error.code, error.message))),
      notifyPeers: () => Effect.fail(unsupported(runtime, "peer-notice")),
    },
    acknowledge: () => {},
    terminate,
    cancelPending,
  };
});

export const makeHerdrBackendDriver = (
  runtime: SubagentRuntime,
  host: HerdrHostShape,
  supervisors: SupervisorChannelShape,
): BackendDriver => ({
  host: "herdr",
  runtime,
  capabilities: ["parent-contact"],
  supportsContext: (context) => context === "fresh",
  preflight: (request) => host.preflight({ runtime, ...request }),
  spawn: (request) =>
    Effect.gen(function* () {
      const launch = withHerdrSupervisorInstructions(request);
      const supervisor = yield* supervisors
        .open({ runId: request.runId })
        .pipe(
          Effect.mapError((error) =>
            processError("open Herdr supervisor channel", error.code, error.message),
          ),
        );
      const hosted = yield* host.launch(runtime, launch, supervisor.metadata);
      return yield* makeHandle(runtime, launch, hosted, supervisor);
    }),
});

export const herdrBackendDrivers = Effect.gen(function* () {
  const host = yield* HerdrHost;
  const supervisors = yield* SupervisorChannel;
  return (["pi", "claude", "codex"] as const).map((runtime) =>
    makeHerdrBackendDriver(runtime, host, supervisors),
  );
});
