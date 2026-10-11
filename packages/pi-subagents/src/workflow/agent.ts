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
import { admitWorkflowAgent } from "./admission.ts";
import {
  discardUnchangedWorktree,
  nullSettlement,
  observedRun,
  outcomeSettlement,
  settledResultLine,
  settlementWarning,
  workflowRefusalReply,
  workflowReply,
  type WorkflowAccounted,
  type WorkflowObservedRun,
  type WorkflowSettlement,
} from "./agent-settlement.ts";
import type { WorkflowSlots, WorkflowWaitOrder } from "./admission-queue.ts";
import type { WorkflowBudget } from "./budget.ts";
import { WorkflowAgentCallError } from "./errors.ts";
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
import { makeWorkflowReuse } from "./reuse.ts";
import type { WorkflowAgentDraft, WorkflowPlannedClaim } from "./state.ts";

export interface WorkflowAgentSpec {
  readonly task: string;
  readonly name: string;
  readonly profile?: string | undefined;
  readonly writes?: ReadonlyArray<string> | undefined;
}

export type WorkflowAgentAccess = "writer" | "read-only";

export interface WorkflowHost {
  readonly checkAgent: (
    options: WorkflowAgentOptions,
  ) => Effect.Effect<WorkflowAgentAccess, WorkflowAgentCallError>;
  readonly resolveAgent: (
    spec: WorkflowAgentSpec,
  ) => Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError>;
}

export interface WorkflowAgentRun {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly host: WorkflowHost;
  readonly replay: WorkflowReplay | undefined;
  readonly slots: WorkflowSlots;
  readonly budget: WorkflowBudget;
  readonly nextCall: Effect.Effect<number | undefined>;
  readonly failRun: (message: string) => Effect.Effect<void>;
  readonly queue: (
    draft: WorkflowAgentDraft,
    skip: Deferred.Deferred<void>,
  ) => Effect.Effect<WorkflowAgentView>;
  readonly claimSkipped: (
    claim: Omit<WorkflowAgentDraft, "callId" | "queuedAt">,
  ) => Effect.Effect<WorkflowAgentView | undefined>;
  readonly update: (runId: string, change: Partial<WorkflowAgentView>) => Effect.Effect<void>;
  readonly forget: (runId: string) => Effect.Effect<void>;
  readonly log: (level: "info" | "warning", message: string) => Effect.Effect<void>;
  readonly stopRequested: Deferred.Deferred<void>;
  readonly count: (spend: WorkflowAgentSpend) => Effect.Effect<void>;
  readonly reuse: (
    entry: WorkflowJournalEntry,
    claim: WorkflowPlannedClaim,
  ) => Effect.Effect<WorkflowPlannedAgent | undefined>;
  readonly writeResult: (line: WorkflowResultLine) => Effect.Effect<void>;
}

export interface WorkflowAgentServices {
  readonly subagents: Pick<
    SubagentServiceContract,
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
}

const CallArguments = Schema.Tuple([Schema.String, Schema.Json, Schema.optionalKey(Schema.String)]);
const decodeCall = Schema.decodeUnknownEffect(CallArguments);

const reject = (message: string) => new WorkflowAgentCallError({ message });

export const makeWorkflowAgentCall = (run: WorkflowAgentRun, services: WorkflowAgentServices) => {
  const { subagents, journal } = services;
  const reuse = makeWorkflowReuse(run, subagents);

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

  const launch = (
    task: string,
    options: WorkflowAgentOptions,
    contract: ResultContract | undefined,
    agent: WorkflowAgentView,
    order: WorkflowWaitOrder,
  ): Effect.Effect<WorkflowSettlement> =>
    admitWorkflowAgent(run, subagents, {
      order,
      label: agent.label,
      owner: { ownerId: run.workflowId, runId: agent.runId },
      resolve: run.host
        .resolveAgent({ task, name: agent.label, profile: options.profile, writes: options.writes })
        .pipe(
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
        ),
      run: (handle) => settle(handle, agent.runId, contract),
      waiting: (waiting) => run.update(agent.runId, { waiting }),
    });

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

  const record = (
    agent: WorkflowAgentView,
    key: string,
    settled: WorkflowSettlement,
    warn = true,
  ) =>
    Effect.gen(function* () {
      const settlement = yield* discardUnchangedWorktree(subagents, run, agent.label, settled);
      yield* run.forget(agent.runId);
      const endedAt = yield* Clock.currentTimeMillis;
      yield* run.update(agent.runId, {
        state: settlement.state,
        endedAt,
        waiting: undefined,
        ...(settlement.reason !== undefined && { reason: settlement.reason }),
        ...(settlement.unchanged && { unchanged: true }),
      });
      if (warn && settlement.state !== "completed" && settlement.refusal === undefined)
        yield* run.log("warning", settlementWarning(agent.label, settlement));
      const accounted = yield* account(agent.runId, settlement, endedAt);
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
      if (settlement.unchanged && settlement.workspaceId !== undefined)
        yield* journal.dropWorkspace(run.workflowId, settlement.workspaceId);
      yield* run.writeResult(settledResultLine(agent, key, settlement, accounted));
      return settlement.refusal === undefined
        ? workflowReply(settlement.result, accounted.spent)
        : workflowRefusalReply(settlement.refusal, accounted.spent);
    });

  const skippedBeforeStart = (agent: WorkflowAgentView, key: string) => {
    const settlement = nullSettlement("skipped", WORKFLOW_SKIPPED_BEFORE_START);
    const accounted = { spend: sumWorkflowSpends([]), spent: 0 };
    return run
      .log("warning", settlementWarning(agent.label, settlement))
      .pipe(
        Effect.andThen(run.writeResult(settledResultLine(agent, key, settlement, accounted))),
        Effect.as(workflowReply(null, 0)),
      );
  };

  return (call: Schema.Json): Effect.Effect<Schema.Json, WorkflowAgentCallError> =>
    reuse.inIssueOrder((consult) =>
      Effect.gen(function* () {
        const [prompt, raw, workflow] = yield* decodeCall(call).pipe(
          Effect.mapError(() =>
            reject("agent(prompt, options) expects a prompt and an options object."),
          ),
        );
        const options = yield* decodeWorkflowAgentOptions(raw);
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
        const settleReused = (reused: WorkflowJournalEntry) =>
          Effect.gen(function* () {
            yield* journal.record(run.workflowId, reused);
            const claimed = yield* run.reuse(reused, claim);
            yield* run.writeResult({
              label: options.label ?? claimed?.label ?? reused.label ?? "reused agent",
              phase: options.phase ?? claimed?.phase,
              profile: options.profile,
              state: "completed",
              reused: true,
              runId: reused.runId,
              workspaceId: reused.workspaceId,
              key,
              outputTokens: reused.outputTokens,
              result: reused.result,
            });
            return workflowReply(reused.result, 0);
          });
        const replayed = yield* consult(key, options, run.host.checkAgent(options), settleReused, {
          claim: run.claimSkipped({ ...claim, profile: options.profile }),
          settle: (agent) => skippedBeforeStart(agent, key),
        });
        if (replayed !== undefined) return replayed;
        const callId = yield* run.nextCall;
        if (callId === undefined) {
          const limit = `A workflow can run at most ${WORKFLOW_AGENT_LIMIT} agents.`;
          yield* run.failRun(limit);
          return yield* reject(limit);
        }
        if (yield* run.budget.exhausted) return workflowRefusalReply(yield* run.budget.refuse, 0);
        const skip = yield* Deferred.make<void>();
        const draft: WorkflowAgentDraft = {
          ...claim,
          callId,
          queuedAt: yield* Clock.currentTimeMillis,
          profile: options.profile,
        };
        const order = run.slots.order(draft.queuedAt);
        return yield* Effect.uninterruptibleMask((restore) => {
          const live = (agent: WorkflowAgentView) =>
            restore(
              launch(prompt, options, contract, agent, order).pipe(
                Effect.raceFirst(
                  Deferred.await(skip).pipe(
                    Effect.as(nullSettlement("skipped", "skipped by the user")),
                  ),
                ),
              ),
            ).pipe(
              Effect.onInterrupt(() =>
                record(agent, key, nullSettlement("stopped", "the workflow stopped"), false).pipe(
                  Effect.asVoid,
                ),
              ),
              Effect.flatMap((settlement) => record(agent, key, settlement)),
            );
          return run
            .queue(draft, skip)
            .pipe(
              Effect.flatMap((agent) =>
                agent.state === "skipped" ? skippedBeforeStart(agent, key) : live(agent),
              ),
            );
        });
      }),
    );
};
