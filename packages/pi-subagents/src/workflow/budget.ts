import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentRuntimeClosedError } from "../run/errors.ts";
import type { SubagentProjection } from "../run/model.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import { makeWorkflowDelegation } from "./delegation.ts";
import type { WorkflowAgentSpend, WorkflowBudgetView } from "./model.ts";

/** Why a queued call the budget refused never started, as its view and results journal line say. */
export const WORKFLOW_BUDGET_REASON = "budget exhausted";

/**
 * The message of the error a refused agent() call throws in the script: `spent` is the count the
 * budget enforced, running agents' live usage included.
 */
const refusalMessage = (spent: number, total: number): string =>
  `The workflow's token budget is spent: ${spent} of ${total} output tokens. agent() can't start more agents; check budget.remaining() before calling it.`;

/** What a settled agent cost its run: its own spend and its subagents', and the budget's count. */
export interface WorkflowBudgetSettlement {
  /** What each subagent the agent started itself used, at every depth. */
  readonly delegated: ReadonlyArray<WorkflowAgentSpend>;
  /** The output tokens the budget counted for the agent and its subagents. */
  readonly counted: number;
}

/**
 * A run's output tokens against its budget. An agent counts its own output and that of the
 * subagents it starts itself, at every depth: settled agents what they spent, running agents
 * their live usage from the subagent projection. Results reused from a resumed run cost nothing
 * here.
 */
export interface WorkflowBudget {
  /** The ceiling the run's start passed; undefined without one. */
  readonly total: number | undefined;
  /** Counts an admitted agent's live output tokens, and its subagents', until it settles. */
  readonly admit: (runId: string) => Effect.Effect<void>;
  /**
   * Settles an agent given its own spend: counts the larger of its reported and its live output
   * tokens, so a skipped or stopped agent still counts what it spent, plus its subagents'.
   */
  readonly settle: (
    runId: string,
    own: WorkflowAgentSpend,
  ) => Effect.Effect<WorkflowBudgetSettlement>;
  /** Whether settled and running agents' tokens have reached the total; once true, stays true. */
  readonly exhausted: Effect.Effect<boolean>;
  /** Completes once the budget is exhausted; never without a total. */
  readonly whenExhausted: Effect.Effect<void>;
  /**
   * Counts a call the budget refused and returns the message of the error its agent() call
   * throws; the first refusal logs the run's only budget warning.
   */
  readonly refuse: Effect.Effect<string>;
  /**
   * Follows every projection change while the run lives: notes what running agents' subagents
   * use, whose records the projection can drop once they end, and, until the budget is
   * exhausted, measures live usage, so queued calls are refused without waiting for an agent to
   * settle and the view follows the live count. It ends when the subagent service closes.
   */
  readonly watch: Effect.Effect<void>;
}

export interface WorkflowBudgetDependencies {
  readonly subagents: Pick<SubagentServiceContract, "projection" | "waitForRevision">;
  /** Logs a run warning. */
  readonly warn: (message: string) => Effect.Effect<void>;
  /** Shows the budget's latest state in the run view; it reads `current` when it applies. */
  readonly show: (current: () => WorkflowBudgetView) => Effect.Effect<void>;
}

/** How many steps the view's live count takes to reach the total, so it isn't shown per frame. */
const LIVE_STEPS = 20;

/** Output tokens the projection reports for the agents in `ids` themselves. */
const ownUsage = (projection: SubagentProjection, ids: ReadonlySet<string>): number => {
  if (ids.size === 0) return 0;
  let usage = 0;
  for (const run of projection.runs) if (ids.has(run.id)) usage += run.usage.output;
  return usage;
};

export const makeWorkflowBudget = (
  total: number | undefined,
  dependencies: WorkflowBudgetDependencies,
): WorkflowBudget => {
  const { subagents, warn, show } = dependencies;
  const running = new Set<string>();
  const delegation = makeWorkflowDelegation();
  /** Running agents' live output tokens, their subagents' as last observed included. */
  const liveUsage = (projection: SubagentProjection): number => {
    let usage = ownUsage(projection, running);
    for (const runId of running) usage += delegation.output(runId);
    return usage;
  };
  const reached = Deferred.makeUnsafe<void>();
  let settled = 0;
  let shown = 0;
  let refused = 0;
  let isExhausted = false;

  const current = (): WorkflowBudgetView => ({ total: total ?? 0, spent: shown, refused });
  const step = total === undefined ? 1 : Math.max(1, Math.ceil(total / LIVE_STEPS));
  /** Records `spent` for the view, synchronously, and whether the view must show it. */
  const noteSpent = (spent: number): boolean => {
    if (total === undefined || spent <= shown) return false;
    shown = spent;
    return true;
  };

  // Running agents' subagents are noted on every measure, with or without a total. The spent
  // count is noted before waiters wake, so a refusal never shows a stale count. Below the total,
  // the view shows live usage once it has grown by a step.
  const measure = (projection: SubagentProjection): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      delegation.observe(projection, running);
      if (total === undefined || isExhausted) return Effect.succeed(isExhausted);
      const spent = settled + liveUsage(projection);
      if (spent < total)
        return spent >= shown + step && noteSpent(spent)
          ? show(current).pipe(Effect.as(false))
          : Effect.succeed(false);
      isExhausted = true;
      noteSpent(spent);
      Deferred.doneUnsafe(reached, Effect.void);
      return show(current).pipe(Effect.as(true));
    });

  const settle: WorkflowBudget["settle"] = (runId, own) =>
    subagents.projection.pipe(
      Effect.flatMap((projection) =>
        Effect.suspend(() => {
          const live = running.delete(runId) ? ownUsage(projection, new Set([runId])) : 0;
          const delegated = delegation.settle(projection, runId);
          const counted =
            Math.max(own.usage.output, live) +
            delegated.reduce((sum, spend) => sum + spend.usage.output, 0);
          settled += counted;
          return (noteSpent(settled) ? show(current) : Effect.void).pipe(
            Effect.andThen(measure(projection)),
            Effect.as({ delegated, counted }),
          );
        }),
      ),
    );

  const refuse = Effect.suspend(() => {
    refused += 1;
    const first = refused === 1;
    return show(current).pipe(
      Effect.andThen(
        first
          ? warn(
              `The token budget of ${total ?? 0} output tokens is spent (${shown} so far), so agent() calls that haven't started throw a budget error, which yields null inside parallel() and pipeline(); agents already running finish.`,
            )
          : Effect.void,
      ),
      Effect.as(refusalMessage(shown, total ?? 0)),
    );
  });

  const watchFrom = (
    projection: SubagentProjection,
  ): Effect.Effect<void, SubagentRuntimeClosedError> =>
    measure(projection).pipe(
      Effect.andThen(subagents.waitForRevision(projection.revision)),
      Effect.andThen(subagents.projection),
      Effect.flatMap(watchFrom),
    );

  return {
    total,
    admit: (runId) => Effect.sync(() => void running.add(runId)),
    settle,
    exhausted:
      total === undefined
        ? Effect.succeed(false)
        : subagents.projection.pipe(Effect.flatMap(measure)),
    whenExhausted: Deferred.await(reached),
    refuse,
    watch: subagents.projection.pipe(Effect.flatMap(watchFrom), Effect.ignore),
  };
};
