import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";
import {
  canonicalResultJson,
  compileResultContract,
  type ResultContract,
} from "../domain/result-contract.ts";
import {
  subagentErrorCode,
  type InvalidSubagentRequestError,
  type SubagentError,
  type SubagentRuntimeClosedError,
  type SubagentWriterConflictError,
} from "../run/errors.ts";
import type { QueuedStartRefusal } from "../run/admission-signal.ts";
import type { StartSubagentRequest } from "../run/model.ts";
import type { OwnedRunHandle, OwnedRunOutcome } from "../run/owned-runs.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowJournalContract, WorkflowJournalEntry, WorkflowReplay } from "./journal.ts";
import {
  WORKFLOW_AGENT_LIMIT,
  type WorkflowAgentView,
  type WorkflowPlannedAgent,
} from "./model.ts";
import {
  decodeWorkflowAgentOptions,
  workflowAgentJournalKey,
  type WorkflowAgentOptions,
} from "./options.ts";
import type { WorkflowResultLine } from "./results.ts";
import type { WorkflowAgentDraft } from "./state.ts";

/** An agent() call as profile resolution sees it. */
export interface WorkflowAgentSpec {
  readonly task: string;
  readonly name: string;
  readonly profile?: string | undefined;
  readonly writes?: ReadonlyArray<string> | undefined;
  readonly isolation?: "worktree" | undefined;
}

/** Rejects the script's agent() promise: the call itself is invalid. */
export class WorkflowAgentCallError extends Schema.TaggedError<WorkflowAgentCallError>()(
  "WorkflowAgentCallError",
  { message: Schema.String },
) {}

/** Profile resolution captured from the tool call that started the run. */
export interface WorkflowHost {
  /** Rejects calls no environment could admit: unknown profiles and writer options on read-only routes. */
  readonly checkAgent: (spec: WorkflowAgentSpec) => Effect.Effect<void, WorkflowAgentCallError>;
  /**
   * Resolves the launch once the call first gets a concurrency slot, which can be before the
   * root has room for it; failures here are environmental.
   */
  readonly resolveAgent: (
    spec: WorkflowAgentSpec,
  ) => Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError>;
}

/** The workflow run an agent() call belongs to; the service owns every piece of state. */
export interface WorkflowAgentRun {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly host: WorkflowHost;
  readonly replay: WorkflowReplay | undefined;
  /** Held by each start attempt and the run it admits, never while a queued call waits. */
  readonly permits: Semaphore.Semaphore;
  /** The next live call position, or undefined once the run's agent limit is reached. */
  readonly nextCall: Effect.Effect<number | undefined>;
  /**
   * Publishes a queued agent whose skip request completes `skip`. It claims the planned entry
   * its phase and label match, taking over that entry's run id, and otherwise reserves its own.
   */
  readonly queue: (
    draft: WorkflowAgentDraft,
    skip: Deferred.Deferred<void>,
  ) => Effect.Effect<WorkflowAgentView>;
  readonly update: (runId: string, change: Partial<WorkflowAgentView>) => Effect.Effect<void>;
  readonly forget: (runId: string) => Effect.Effect<void>;
  readonly log: (level: "info" | "warning", message: string) => Effect.Effect<void>;
  /** Adds a live agent's spent output tokens. */
  readonly count: (outputTokens: number) => Effect.Effect<void>;
  /**
   * Counts a result reused from the resumed run, with its tokens and display phase, and lists its
   * worktree as a proposal when the entry still names one. The call claims its planned entry
   * like a live one, and gets it back.
   */
  readonly reuse: (
    entry: WorkflowJournalEntry,
    phase: string | undefined,
    label: string | undefined,
  ) => Effect.Effect<WorkflowPlannedAgent | undefined>;
  /** Appends a finished call to the run's results journal file; best effort. */
  readonly writeResult: (line: WorkflowResultLine) => Effect.Effect<void>;
}

export interface WorkflowAgentServices {
  readonly subagents: Pick<
    SubagentServiceContract,
    | "reserveRunId"
    | "startOwned"
    | "awaitOwned"
    | "admissionRevision"
    | "waitForAdmissionChange"
    | "queuedStartRefused"
    | "workspaceBindingStatus"
    | "projection"
  >;
  readonly journal: Pick<WorkflowJournalContract, "record" | "noteWorkspace">;
}

type StartFailure = SubagentError | SubagentRuntimeClosedError;

interface Settlement {
  readonly state: "completed" | "failed" | "stopped" | "skipped";
  readonly result: Schema.Json;
  readonly outputTokens: number;
  readonly reason?: string | undefined;
  /** The writer's worktree, once admitted. */
  readonly workspaceId?: string | undefined;
}

const CallArguments = Schema.Tuple([Schema.String, Schema.Json]);
const decodeCall = Schema.decodeUnknownEffect(CallArguments);
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const reject = (message: string) => new WorkflowAgentCallError({ message });
const reply = (result: Schema.Json, outputTokens: number): Schema.Json => ({
  result,
  outputTokens,
});

const nullResult = (state: Settlement["state"], reason: string, outputTokens = 0): Settlement => ({
  state,
  result: null,
  outputTokens,
  reason,
});

/** One start attempt under a permit: settled, or refused for a reason a later release clears. */
type Attempt =
  | { readonly settled: Settlement }
  | { readonly queued: StartFailure; readonly revision: number };

/**
 * Refusals this session clears by itself: the root's direct-child capacity, or a writer
 * conflict with one of its own runs, such as the previous writer still cleaning up.
 */
const isQueueable = (error: StartFailure): boolean => {
  if (error._tag === "SubagentWriterConflictError") return error.transient === true;
  return (
    error._tag !== "SubagentRuntimeClosedError" &&
    subagentErrorCode(error) === "direct_child_capacity"
  );
};

const writerConflictOf = (error: StartFailure): SubagentWriterConflictError | undefined =>
  error._tag === "SubagentWriterConflictError" ? error : undefined;

const refusalOf = (error: StartFailure): QueuedStartRefusal =>
  error._tag === "SubagentWriterConflictError" ? "writer_conflict" : "capacity";

/** Why a resumed worktree writer runs again instead of reusing its result. */
const rerunReason = (workspaceId: string, status: "closed" | "unbound"): string =>
  status === "closed"
    ? `its worktree ${workspaceId} was discarded, or its integration wasn't confirmed, so its edit may not be in the checkout.`
    : `its worktree ${workspaceId} was created before the session was reloaded, navigated or replaced, so this session can't review or integrate it.`;

/** What a queued writer waits on; it can be a writer the user paused or keeps for guidance. */
const waitingLine = (label: string, conflict: SubagentWriterConflictError): string =>
  `agent "${label}" is queued behind ${conflict.activeName} (${conflict.activeId}): ${conflict.message}`;

const outcomeSettlement = (
  outcome: OwnedRunOutcome,
  contract: ResultContract | undefined,
): Settlement => {
  const outputTokens = outcome.usage.output;
  if (outcome.kind !== "completed") return nullResult(outcome.kind, outcome.reason, outputTokens);
  if (!contract) return { state: "completed", result: outcome.text, outputTokens };
  // A contract run completes only with the canonical JSON of its validated value.
  return Option.match(decodeResult(outcome.text), {
    onNone: () => nullResult("failed", "The structured result wasn't valid JSON.", outputTokens),
    onSome: (result): Settlement => ({ state: "completed", result, outputTokens }),
  });
};

const warning = (label: string, settlement: Settlement): string => {
  const reason = settlement.reason ? `: ${settlement.reason}` : "";
  switch (settlement.state) {
    case "skipped":
      return `agent "${label}" was skipped${reason}`;
    case "stopped":
      return `agent "${label}" was stopped${reason}`;
    default:
      return `agent "${label}" failed${reason}`;
  }
};

/** A live call's results journal line, with the profile it ran with rather than a planned one. */
const resultLine = (
  callId: number,
  agent: WorkflowAgentView,
  profile: string | undefined,
  settlement: Settlement,
): WorkflowResultLine => ({
  callId,
  label: agent.label,
  phase: agent.phase,
  profile,
  state: settlement.state,
  reason: settlement.reason,
  runId: agent.runId,
  workspaceId: settlement.workspaceId,
  outputTokens: settlement.outputTokens,
  result: settlement.result,
});

/**
 * One script `agent(prompt, options)` call. It rejects only for an invalid call; once queued it
 * always settles to a value or null. Interruption, including a skip, stops the owned subagent
 * and releases its report before the call returns.
 */
export const makeWorkflowAgentCall = (run: WorkflowAgentRun, services: WorkflowAgentServices) => {
  const { subagents, journal } = services;

  /** Awaits an admitted run's outcome; the caller's scope owns the run until it is consumed. */
  const settle = (
    handle: OwnedRunHandle,
    runId: string,
    contract: ResultContract | undefined,
  ): Effect.Effect<Settlement> =>
    Effect.gen(function* () {
      const workspaceId = (yield* subagents.projection).runs.find(
        (view) => view.id === runId,
      )?.workspaceId;
      if (workspaceId !== undefined) yield* journal.noteWorkspace(run.workflowId, workspaceId);
      yield* run.update(runId, {
        state: "running",
        startedAt: yield* Clock.currentTimeMillis,
        ...(workspaceId !== undefined && { workspaceId }),
      });
      const outcome = yield* Effect.result(subagents.awaitOwned(handle));
      const settlement =
        outcome._tag === "Failure"
          ? nullResult("failed", outcome.failure.message)
          : outcomeSettlement(outcome.success, contract);
      return workspaceId === undefined ? settlement : { ...settlement, workspaceId };
    });

  /**
   * One attempt under a permit: starts the agent and, once admitted, runs it to its outcome
   * while still holding the permit. A queueable refusal gives the permit back at once, with the
   * admission revision read before the start, so a release during the attempt isn't missed.
   */
  const attempt = (
    request: StartSubagentRequest,
    runId: string,
    contract: ResultContract | undefined,
  ): Effect.Effect<Attempt> =>
    Effect.scoped(
      Effect.gen(function* () {
        const revision = yield* subagents.admissionRevision;
        const started = yield* Effect.result(
          subagents.startOwned(request, { ownerId: run.workflowId, runId }),
        );
        if (started._tag === "Success")
          return { settled: yield* settle(started.success, runId, contract) };
        if (isQueueable(started.failure)) return { queued: started.failure, revision };
        return { settled: nullResult("failed", `couldn't start: ${started.failure.message}`) };
      }),
    ).pipe(run.permits.withPermits(1));

  /**
   * Waits for releases until the refusal stops standing. Every release wakes every queued call,
   * so each checks its refusal cheaply under the run lock before paying for a full start; the
   * revision is read before that check, so a release during it isn't missed.
   */
  const awaitAdmissible = (
    request: StartSubagentRequest,
    refusal: QueuedStartRefusal,
    revision: number,
  ): Effect.Effect<void, SubagentRuntimeClosedError> =>
    subagents.waitForAdmissionChange(revision).pipe(
      Effect.andThen(subagents.admissionRevision),
      Effect.flatMap((next) =>
        subagents
          .queuedStartRefused(request, refusal)
          .pipe(
            Effect.flatMap((refused) =>
              refused ? awaitAdmissible(request, refusal, next) : Effect.void,
            ),
          ),
      ),
    );

  /**
   * Retries a queued start once something that refused it is released. Waiting holds no
   * permit, so other agents, such as readers behind a queued writer, keep starting. Each new
   * writer it waits behind is logged, since that writer may never clear by itself.
   */
  const startWhenAdmitted = (
    request: StartSubagentRequest,
    runId: string,
    contract: ResultContract | undefined,
    label: string,
    waitingOn?: string,
  ): Effect.Effect<Settlement> =>
    attempt(request, runId, contract).pipe(
      Effect.flatMap((step): Effect.Effect<Settlement> => {
        if ("settled" in step) return Effect.succeed(step.settled);
        const conflict = writerConflictOf(step.queued);
        const line = conflict && waitingLine(label, conflict);
        return (
          line !== undefined && line !== waitingOn ? run.log("info", line) : Effect.void
        ).pipe(
          Effect.andThen(awaitAdmissible(request, refusalOf(step.queued), step.revision)),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.succeed(nullResult("failed", `couldn't start: ${error.message}`)),
            onSuccess: () => startWhenAdmitted(request, runId, contract, label, line ?? waitingOn),
          }),
        );
      }),
    );

  const launch = (
    spec: WorkflowAgentSpec,
    options: WorkflowAgentOptions,
    contract: ResultContract | undefined,
    runId: string,
  ): Effect.Effect<Settlement> =>
    Effect.gen(function* () {
      // The route, and a fork-context profile's fork of the root conversation, resolve once,
      // when the call first gets a concurrency slot. A call the root then refuses for capacity
      // or a writer conflict keeps that request while it waits.
      const resolved = yield* Effect.result(
        run.host.resolveAgent(spec).pipe(run.permits.withPermits(1)),
      );
      if (resolved._tag === "Failure")
        return nullResult("failed", `couldn't start: ${resolved.failure.message}`);
      const request: StartSubagentRequest = {
        ...resolved.success,
        workflow: {
          workflowId: run.workflowId,
          name: run.workflowName,
          ...(options.phase !== undefined && { phase: options.phase }),
        },
        ...(options.isolation === "worktree" && { writerWorkspaceModeOverride: "worktree" }),
        ...(contract && { resultContract: contract }),
      };
      return yield* startWhenAdmitted(request, runId, contract, spec.name);
    });

  const finish = (runId: string, settlement: Settlement) =>
    Effect.gen(function* () {
      yield* run.forget(runId);
      yield* run.update(runId, {
        state: settlement.state,
        endedAt: yield* Clock.currentTimeMillis,
        ...(settlement.reason !== undefined && { reason: settlement.reason }),
      });
    });

  /**
   * The resumed run's result for this call and the entry its view counts. A worktree writer's
   * result is reused only while its edit awaits review, listed as a proposal, or after it was
   * integrated into the checkout, unlisted. A writer whose worktree was discarded, whose
   * integration is unconfirmed, or that this session never bound, runs again.
   */
  const replayable = (key: string, options: WorkflowAgentOptions) =>
    Effect.gen(function* () {
      const entry = run.replay?.take(key);
      if (entry?.workspaceId === undefined) return entry && { entry, counted: entry };
      const status = yield* subagents.workspaceBindingStatus(entry.workspaceId);
      if (status === "pending") return { entry, counted: entry };
      if (status === "integrated") {
        const { workspaceId: _integrated, ...rest } = entry;
        const counted: WorkflowJournalEntry = rest;
        return { entry, counted };
      }
      const label = options.label ?? entry.label ?? "agent";
      yield* run.log(
        "info",
        `agent "${label}" runs again instead of reusing its earlier result: ${rerunReason(entry.workspaceId, status)}`,
      );
      return undefined;
    });

  return (call: Schema.Json): Effect.Effect<Schema.Json, WorkflowAgentCallError> =>
    Effect.gen(function* () {
      const [prompt, raw] = yield* decodeCall(call).pipe(
        Effect.mapError(() =>
          reject("agent(prompt, options) expects a prompt and an options object."),
        ),
      );
      const options = yield* decodeWorkflowAgentOptions(raw).pipe(
        Effect.mapError((error) => reject(error.message)),
      );
      const contract =
        options.schema === undefined
          ? undefined
          : yield* compileResultContract(options.schema).pipe(
              Effect.mapError((error) => reject(`Invalid agent() schema: ${error.message}`)),
            );
      const key = workflowAgentJournalKey(prompt, options, contract?.digest);
      const reused = yield* replayable(key, options);
      if (reused)
        // Settled once taken from the replay, so a stop can't drop its journal line.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            // Recorded again, worktree included, so a resumed run can itself be resumed.
            yield* journal.record(run.workflowId, reused.entry);
            const claimed = yield* run.reuse(reused.counted, options.phase, options.label);
            yield* run.writeResult({
              label: options.label ?? claimed?.label ?? reused.entry.label ?? "reused agent",
              phase: options.phase,
              profile: options.profile,
              state: "completed",
              reused: true,
              runId: reused.entry.runId,
              workspaceId: reused.counted.workspaceId,
              outputTokens: reused.entry.outputTokens,
              result: reused.entry.result,
            });
            return reply(reused.entry.result, reused.entry.outputTokens);
          }),
        );
      const spec: WorkflowAgentSpec = {
        task: prompt,
        name: options.label ?? "",
        profile: options.profile,
        writes: options.writes,
        isolation: options.isolation,
      };
      yield* run.host.checkAgent(spec);
      const callId = yield* run.nextCall;
      if (callId === undefined)
        return yield* reject(`A workflow can run at most ${WORKFLOW_AGENT_LIMIT} agents.`);
      const skip = yield* Deferred.make<void>();
      const draft: WorkflowAgentDraft = {
        callId,
        queuedAt: yield* Clock.currentTimeMillis,
        label: options.label,
        phase: options.phase,
        profile: options.profile,
      };
      const stopped = nullResult("stopped", "the workflow stopped");
      /** Settles a call's view, tokens, resume journal and results journal line. */
      const record = (agent: WorkflowAgentView, settlement: Settlement) =>
        Effect.gen(function* () {
          yield* finish(agent.runId, settlement);
          if (settlement.state !== "completed")
            yield* run.log("warning", warning(agent.label, settlement));
          yield* run.count(settlement.outputTokens);
          if (settlement.state === "completed")
            yield* journal.record(run.workflowId, {
              key,
              result: settlement.result,
              outputTokens: settlement.outputTokens,
              chars: canonicalResultJson(settlement.result).length,
              label: agent.label,
              runId: agent.runId,
              ...(settlement.workspaceId !== undefined && { workspaceId: settlement.workspaceId }),
            });
          yield* run.writeResult(resultLine(callId, agent, options.profile, settlement));
          return reply(settlement.result, settlement.outputTokens);
        });
      // Only the launch can be interrupted: a published agent always settles its view, and a
      // settled call always records its journal line, even when the run stops meanwhile.
      return yield* Effect.uninterruptibleMask((restore) =>
        run.queue(draft, skip).pipe(
          Effect.flatMap((agent) =>
            restore(
              launch({ ...spec, name: agent.label }, options, contract, agent.runId).pipe(
                Effect.raceFirst(
                  Deferred.await(skip).pipe(
                    Effect.as(nullResult("skipped", "skipped by the user")),
                  ),
                ),
              ),
            ).pipe(
              // The script is gone when its call is interrupted, so only the view and the
              // journal need settling.
              Effect.onInterrupt(() =>
                finish(agent.runId, stopped).pipe(
                  Effect.andThen(
                    run.writeResult(resultLine(callId, agent, options.profile, stopped)),
                  ),
                ),
              ),
              Effect.flatMap((settlement) => record(agent, settlement)),
            ),
          ),
        ),
      );
    });
};
