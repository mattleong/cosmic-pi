import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentRuntimeClosedError } from "../run/errors.ts";
import type { SubagentProjection } from "../run/model.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import { makeWorkflowDelegation } from "./delegation.ts";
import type { WorkflowAgentSpend, WorkflowBudgetView } from "./model.ts";

export const WORKFLOW_BUDGET_REASON = "budget exhausted";

const refusalMessage = (spent: number, total: number): string =>
  `The workflow's token budget is spent: ${spent} of ${total} output tokens. agent() can't start more agents; check budget.remaining() before calling it.`;

interface WorkflowBudgetSettlement {
  readonly delegated: ReadonlyArray<WorkflowAgentSpend>;
  readonly counted: number;
}

interface WorkflowBudgetDependencies {
  readonly subagents: Pick<SubagentServiceContract, "projection" | "waitForRevision">;
  readonly warn: (message: string) => Effect.Effect<void>;
  readonly show: (current: () => WorkflowBudgetView) => Effect.Effect<void>;
}

const LIVE_STEPS = 20;

export const makeWorkflowBudget = (
  total: number | undefined,
  dependencies: WorkflowBudgetDependencies,
) => {
  const { subagents, warn, show } = dependencies;
  const running = new Set<string>();
  const delegation = makeWorkflowDelegation();
  const liveUsage = (projection: SubagentProjection): number => {
    if (running.size === 0) return 0;
    let usage = 0;
    for (const run of projection.runs) if (running.has(run.id)) usage += run.usage.output;
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
  const noteSpent = (spent: number): boolean => {
    if (total === undefined || spent <= shown) return false;
    shown = spent;
    return true;
  };

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

  const settle = (
    runId: string,
    own: WorkflowAgentSpend,
  ): Effect.Effect<WorkflowBudgetSettlement> =>
    Effect.gen(function* () {
      const projection = yield* subagents.projection;
      const live = running.delete(runId)
        ? (projection.runs.find((run) => run.id === runId)?.usage.output ?? 0)
        : 0;
      const delegated = delegation.settle(projection, runId);
      const counted =
        Math.max(own.usage.output, live) +
        delegated.reduce((sum, spend) => sum + spend.usage.output, 0);
      settled += counted;
      if (noteSpent(settled)) yield* show(current);
      yield* measure(projection);
      return { delegated, counted };
    });

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
    admit: (runId: string) => Effect.sync(() => void running.add(runId)),
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

export type WorkflowBudget = ReturnType<typeof makeWorkflowBudget>;
