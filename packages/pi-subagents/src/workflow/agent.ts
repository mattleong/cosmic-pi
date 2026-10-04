import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  canonicalResultJson,
  compileResultContract,
  type ResultContract,
} from "../domain/result-contract.ts";
import type { InvalidSubagentRequestError } from "../run/errors.ts";
import type { StartSubagentRequest } from "../run/model.ts";
import type { OwnedRunHandle } from "../run/owned-runs.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import { admitWorkflowAgent, type WorkflowAdmissionGate } from "./admission.ts";
import {
  discardUnchangedWorktree,
  nullSettlement,
  observedRun,
  outcomeSettlement,
  overBudgetSettlement,
  settledResultLine,
  settlementWarning,
  workflowRefusalReply,
  workflowReply,
  type WorkflowAccounted,
  type WorkflowObservedRun,
  type WorkflowSettlement,
} from "./agent-settlement.ts";
import type {
  WorkflowAdmissionQueue,
  WorkflowCapacityWaiter,
  WorkflowQueued,
  WorkflowWaitOrder,
} from "./admission-queue.ts";
import type { WorkflowBudget } from "./budget.ts";
import type { WorkflowJournalContract, WorkflowJournalEntry, WorkflowReplay } from "./journal.ts";
import {
  sumWorkflowSpends,
  WORKFLOW_AGENT_LIMIT,
  WORKFLOW_SKIPPED_BEFORE_START,
  type WorkflowAgentSpend,
  type WorkflowAgentView,
  type WorkflowPlannedAgent,
} from "./model.ts";
import {
  decodeWorkflowAgentOptions,
  workflowAgentJournalKey,
  type WorkflowAgentOptions,
} from "./options.ts";
import type { WorkflowResultLine } from "./results.ts";
import { makeWorkflowReuse, type WorkflowReused } from "./reuse.ts";
import type { WorkflowAgentDraft, WorkflowPlannedClaim } from "./state.ts";

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

/** Whether a valid call's profile can write; a writer without worktree isolation edits the checkout. */
export type WorkflowAgentAccess = "writer" | "read-only";

/** Profile resolution captured from the tool call that started the run. */
export interface WorkflowHost {
  /**
   * Rejects calls no environment could admit, unknown profiles and writer options on read-only
   * routes, and otherwise returns whether the call's profile can write.
   */
  readonly checkAgent: (
    spec: WorkflowAgentSpec,
  ) => Effect.Effect<WorkflowAgentAccess, WorkflowAgentCallError>;
  /**
   * Resolves the launch once the call first gets one of its run's slots, which can be before
   * the root has room for it; failures here are environmental.
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
  /** The run's slots, held by each start and the agent it admits, never behind a writer. */
  readonly slots: WorkflowAdmissionQueue<WorkflowQueued>;
  /** Where a call queued at `queuedAt` stands among the session's waiting starts. */
  readonly order: (queuedAt: number) => WorkflowWaitOrder;
  /** The run's token budget, which also tracks its spent output tokens without a total. */
  readonly budget: WorkflowBudget;
  /** The next live call position, or undefined once the run's agent limit is reached. */
  readonly nextCall: Effect.Effect<number | undefined>;
  /** Fails the whole run with `message` from the host, which no catch in the script can stop. */
  readonly failRun: (message: string) => Effect.Effect<void>;
  /**
   * Publishes a queued agent whose skip request completes `skip`. It claims the planned entry
   * its phase and label match, taking over that entry's run id and, when it has no phase, the
   * entry's phase, and otherwise reserves its own. An agent that claims an entry the user skipped
   * since the call looked for one is published already skipped.
   */
  readonly queue: (
    draft: WorkflowAgentDraft,
    skip: Deferred.Deferred<void>,
  ) => Effect.Effect<WorkflowAgentView>;
  /**
   * Claims the planned entry the call would claim when the user skipped it, and publishes the
   * call's view, already skipped and with a position of its own, in the same step; undefined,
   * changing nothing, when the call would claim no skipped entry.
   */
  readonly claimSkipped: (
    claim: Omit<WorkflowAgentDraft, "callId" | "queuedAt">,
  ) => Effect.Effect<WorkflowAgentView | undefined>;
  readonly update: (runId: string, change: Partial<WorkflowAgentView>) => Effect.Effect<void>;
  readonly forget: (runId: string) => Effect.Effect<void>;
  readonly log: (level: "info" | "warning", message: string) => Effect.Effect<void>;
  /** Completed once someone asks the run to stop. */
  readonly stopRequested: Deferred.Deferred<void>;
  /** Adds what a settled live agent used to the run's usage. */
  readonly count: (spend: WorkflowAgentSpend) => Effect.Effect<void>;
  /**
   * Counts a result reused from the resumed run in its display phase, at no cost, and lists its
   * worktree as a proposal when the entry still names one. The call claims its planned entry
   * like a live one, and gets it back.
   */
  readonly reuse: (
    entry: WorkflowJournalEntry,
    claim: WorkflowPlannedClaim,
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
    | "waitForRevision"
    | "queuedWriterConflict"
    | "workspaceBindingStatus"
    | "workspaceDiscardUnchanged"
    | "projection"
  >;
  readonly journal: Pick<WorkflowJournalContract, "record" | "noteWorkspace" | "dropWorkspace">;
  /** The session's workflow starts waiting for root capacity. */
  readonly capacity: WorkflowAdmissionQueue<WorkflowCapacityWaiter>;
}

/** The prompt and options, then the nested workflow() the call was made in, by name. */
const CallArguments = Schema.Tuple([Schema.String, Schema.Json, Schema.optionalKey(Schema.String)]);
const decodeCall = Schema.decodeUnknownEffect(CallArguments);

const reject = (message: string) => new WorkflowAgentCallError({ message });

/**
 * One script `agent(prompt, options)` call. It rejects only for an invalid call; otherwise it
 * replies with a value or null, or with the budget's refusal, which the prelude throws as a
 * budget error, when the budget is spent before its agent starts. Interruption, including a
 * skip, stops the owned subagent and releases its report before the call returns.
 */
export const makeWorkflowAgentCall = (run: WorkflowAgentRun, services: WorkflowAgentServices) => {
  const { subagents, journal } = services;
  const gate: WorkflowAdmissionGate = {
    slots: run.slots,
    capacity: services.capacity,
    budget: run.budget,
    log: run.log,
    subagents,
  };
  const reuse = makeWorkflowReuse(run, subagents);

  /** Awaits an admitted run's outcome; the caller's scope owns the run until it is consumed. */
  const settle = (
    handle: OwnedRunHandle,
    runId: string,
    contract: ResultContract | undefined,
  ): Effect.Effect<WorkflowSettlement> =>
    Effect.gen(function* () {
      yield* run.budget.admit(runId);
      const workspaceId = (yield* subagents.projection).runs.find(
        (view) => view.id === runId,
      )?.workspaceId;
      if (workspaceId !== undefined) yield* journal.noteWorkspace(run.workflowId, workspaceId);
      const startedAt = yield* Clock.currentTimeMillis;
      yield* run.update(runId, {
        state: "running",
        startedAt,
        waiting: undefined,
        ...(workspaceId !== undefined && { workspaceId }),
      });
      const outcome = yield* Effect.result(subagents.awaitOwned(handle));
      const settlement =
        outcome._tag === "Failure"
          ? nullSettlement("failed", outcome.failure.message)
          : outcomeSettlement(outcome.success, contract);
      return { ...settlement, startedAt, ...(workspaceId !== undefined && { workspaceId }) };
    });

  /** Admits and runs a queued agent, in its view's phase, which a claimed entry may have set. */
  const launch = (
    spec: WorkflowAgentSpec,
    options: WorkflowAgentOptions,
    contract: ResultContract | undefined,
    agent: WorkflowAgentView,
    order: WorkflowWaitOrder,
  ): Effect.Effect<WorkflowSettlement> =>
    admitWorkflowAgent(gate, {
      order,
      runId: agent.runId,
      label: spec.name,
      // The route, and a fork-context profile's fork of the root conversation, resolve once,
      // when the call first gets a slot. A call the root then refuses for capacity or a writer
      // conflict keeps that request while it waits.
      resolve: run.host.resolveAgent(spec).pipe(
        Effect.map(
          (resolved): StartSubagentRequest => ({
            ...resolved,
            workflow: {
              workflowId: run.workflowId,
              name: run.workflowName,
              ...(agent.phase !== undefined && { phase: agent.phase }),
            },
            ...(options.isolation === "worktree" && { writerWorkspaceModeOverride: "worktree" }),
            ...(contract && { resultContract: contract }),
          }),
        ),
        Effect.mapError((error) => nullSettlement("failed", `couldn't start: ${error.message}`)),
        Effect.result,
      ),
      // Each attempt asks the root again, so the start is made anew every time.
      start: (request) =>
        Effect.suspend(() =>
          subagents.startOwned(request, { ownerId: run.workflowId, runId: agent.runId }),
        ),
      run: (handle) => settle(handle, agent.runId, contract),
      refused: (error) => nullSettlement("failed", `couldn't start: ${error.message}`),
      exhausted: overBudgetSettlement,
      waiting: (waiting) => run.update(agent.runId, { waiting }),
    });

  /** Settles the agent's view and returns when it ended. */
  const finish = (runId: string, settlement: WorkflowSettlement) =>
    Effect.gen(function* () {
      yield* run.forget(runId);
      const endedAt = yield* Clock.currentTimeMillis;
      yield* run.update(runId, {
        state: settlement.state,
        endedAt,
        waiting: undefined,
        ...(settlement.reason !== undefined && { reason: settlement.reason }),
        ...(settlement.unchanged && { unchanged: true }),
      });
      return endedAt;
    });

  /**
   * Counts what a settled agent used, and what the subagents it started itself used, in its
   * budget and its run's usage. An agent without an outcome, such as one skipped or stopped while
   * it ran, counts what its subagent shows, and names the worktree its subagent shows.
   */
  const account = (runId: string, settlement: WorkflowSettlement, endedAt: number) =>
    Effect.gen(function* () {
      const observed: WorkflowObservedRun = settlement.spend
        ? { spend: settlement.spend }
        : observedRun(yield* subagents.projection, runId);
      const budgeted = yield* run.budget.settle(runId, observed.spend);
      const spends = [observed.spend, ...budgeted.delegated];
      yield* Effect.forEach(spends, run.count, { discard: true });
      const startedAt = settlement.startedAt ?? observed.startedAt;
      return {
        spend: sumWorkflowSpends(spends),
        spent: budgeted.counted,
        ...(startedAt !== undefined && { durationMs: Math.max(0, endedAt - startedAt) }),
        ...(observed.workspaceId !== undefined && { workspaceId: observed.workspaceId }),
      } satisfies WorkflowAccounted;
    });

  return (call: Schema.Json): Effect.Effect<Schema.Json, WorkflowAgentCallError> =>
    reuse.inIssueOrder((consult) =>
      Effect.gen(function* () {
        const [prompt, raw, workflow] = yield* decodeCall(call).pipe(
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
        const claim: WorkflowPlannedClaim = {
          phase: options.phase,
          label: options.label,
          workflow,
        };
        const spec: WorkflowAgentSpec = {
          task: prompt,
          name: options.label ?? "",
          profile: options.profile,
          writes: options.writes,
          isolation: options.isolation,
        };
        /** Settles a reused result in the step that took it, so a stop can't drop its journal line. */
        const settleReused = (reused: WorkflowReused) =>
          Effect.gen(function* () {
            // Recorded again, worktree included, so a resumed run can itself be resumed.
            yield* journal.record(run.workflowId, reused.entry);
            const claimed = yield* run.reuse(reused.counted, claim);
            yield* run.writeResult({
              label: options.label ?? claimed?.label ?? reused.entry.label ?? "reused agent",
              phase: options.phase ?? claimed?.phase,
              profile: options.profile,
              state: "completed",
              reused: true,
              runId: reused.entry.runId,
              workspaceId: reused.counted.workspaceId,
              key,
              outputTokens: reused.entry.outputTokens,
              result: reused.entry.result,
            });
            // A reused result costs nothing in this run, so budget.spent() doesn't grow.
            return workflowReply(reused.entry.result, 0);
          });
        /**
         * A call that claimed a planned agent the user skipped: it resolves null at once, starting
         * nothing and holding no slot or budget, and only its warning and journal line are left.
         */
        const skippedBeforeStart = (agent: WorkflowAgentView) => {
          const settlement = nullSettlement("skipped", WORKFLOW_SKIPPED_BEFORE_START);
          const accounted = { spend: sumWorkflowSpends([]), spent: 0 };
          return run
            .log("warning", settlementWarning(agent.label, settlement))
            .pipe(
              Effect.andThen(
                run.writeResult(
                  settledResultLine(
                    agent.callId,
                    agent,
                    options.profile,
                    key,
                    settlement,
                    accounted,
                  ),
                ),
              ),
              Effect.as(workflowReply(null, 0)),
            );
        };
        // A call that runs live is checked first; a reused or skipped one starts nothing now.
        const replayed = yield* consult(key, options, run.host.checkAgent(spec), settleReused, {
          claim: run.claimSkipped({ ...claim, profile: options.profile }),
          settle: skippedBeforeStart,
        });
        if (replayed !== undefined) return replayed;
        // Every live call takes a position, refused ones too, so a script that retries refused
        // calls ends at the agent limit instead of looping once the budget is spent. The limit
        // fails the run from the host, so it ends a retry loop that catches every error too.
        const callId = yield* run.nextCall;
        if (callId === undefined) {
          const limit = `A workflow can run at most ${WORKFLOW_AGENT_LIMIT} agents.`;
          yield* run.failRun(limit);
          return yield* reject(limit);
        }
        // A call once the budget is spent never queues and gets no view; the run counts it and
        // warns once.
        if (yield* run.budget.exhausted) return workflowRefusalReply(yield* run.budget.refuse, 0);
        const skip = yield* Deferred.make<void>();
        const draft: WorkflowAgentDraft = {
          ...claim,
          callId,
          queuedAt: yield* Clock.currentTimeMillis,
          profile: options.profile,
        };
        const order = run.order(draft.queuedAt);
        const stopped = nullSettlement("stopped", "the workflow stopped");
        /**
         * Settles a call's view, usage, resume journal and results journal line, once a worktree
         * writer's worktree is checked for changes.
         */
        const record = (agent: WorkflowAgentView, settled: WorkflowSettlement) =>
          Effect.gen(function* () {
            const settlement = yield* discardUnchangedWorktree(
              subagents,
              run,
              agent.label,
              settled,
            );
            const endedAt = yield* finish(agent.runId, settlement);
            if (settlement.state !== "completed" && settlement.refusal === undefined)
              yield* run.log("warning", settlementWarning(agent.label, settlement));
            const accounted = yield* account(agent.runId, settlement, endedAt);
            // A writer whose worktree held no changes left nothing to review or integrate, so a
            // resume reuses its result like a reader's.
            if (settlement.state === "completed")
              yield* journal.record(run.workflowId, {
                key,
                result: settlement.result,
                outputTokens: accounted.spend.usage.output,
                chars: canonicalResultJson(settlement.result).length,
                label: agent.label,
                runId: agent.runId,
                ...(settlement.workspaceId !== undefined &&
                  !settlement.unchanged && { workspaceId: settlement.workspaceId }),
              });
            // A discarded worktree isn't one a teardown notice lists for recovery.
            if (settlement.unchanged && settlement.workspaceId !== undefined)
              yield* journal.dropWorkspace(run.workflowId, settlement.workspaceId);
            yield* run.writeResult(
              settledResultLine(callId, agent, options.profile, key, settlement, accounted),
            );
            return settlement.refusal === undefined
              ? workflowReply(settlement.result, accounted.spent)
              : workflowRefusalReply(settlement.refusal, accounted.spent);
          });
        // Only the launch can be interrupted: a published agent always settles its view, and a
        // settled call always records its journal line, even when the run stops meanwhile.
        return yield* Effect.uninterruptibleMask((restore) => {
          const live = (agent: WorkflowAgentView) =>
            restore(
              launch({ ...spec, name: agent.label }, options, contract, agent, order).pipe(
                Effect.raceFirst(
                  Deferred.await(skip).pipe(
                    Effect.as(nullSettlement("skipped", "skipped by the user")),
                  ),
                ),
              ),
            ).pipe(
              // The script is gone when its call is interrupted, so only the view, what the
              // agent used and the journal need settling.
              Effect.onInterrupt(() =>
                finish(agent.runId, stopped).pipe(
                  Effect.flatMap((endedAt) => account(agent.runId, stopped, endedAt)),
                  Effect.flatMap((accounted) =>
                    run.writeResult(
                      settledResultLine(callId, agent, options.profile, key, stopped, accounted),
                    ),
                  ),
                ),
              ),
              Effect.flatMap((settlement) => record(agent, settlement)),
            );
          return run
            .queue(draft, skip)
            .pipe(
              Effect.flatMap((agent) =>
                agent.state === "skipped" ? skippedBeforeStart(agent) : live(agent),
              ),
            );
        });
      }),
    );
};
