import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import { countLabel, formatCost } from "pi-cosmic-core/display";
import type { SubagentProjection, SubagentRunView } from "./model.ts";
import { isActiveRunState } from "./model.ts";

export const emptyProjection = (): SubagentProjection => ({
  revision: 0,
  runs: [],
});

// Active runs first, then newest first.
const runOrder: Order.Order<SubagentRunView> = Order.combine(
  Order.mapInput(Order.flip(Order.Boolean), (run: SubagentRunView) => isActiveRunState(run.state)),
  Order.mapInput(Order.flip(Order.Number), (run: SubagentRunView) => run.startedAt),
);

export const sortRuns = (runs: ReadonlyArray<SubagentRunView>): ReadonlyArray<SubagentRunView> =>
  Arr.sort(runs, runOrder);

export const fleetStatus = (projection: SubagentProjection): string | undefined => {
  const owned = Arr.filter(projection.runs, (run) => isActiveRunState(run.state)).length;
  const working = Arr.filter(
    projection.runs,
    (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
  ).length;
  const waiting = Arr.filter(projection.runs, (run) => run.state === "waiting_for_parent").length;
  const paused = Arr.filter(projection.runs, (run) => run.state === "paused").length;
  if (owned === 0) return undefined;
  const spent = projection.sessionUsage?.cost;
  return Arr.join(
    Arr.filter(
      [
        working ? `${countLabel(working, "subagent")} running` : undefined,
        waiting ? `${waiting} waiting for reply` : undefined,
        paused ? `${paused} paused` : undefined,
        spent ? `${formatCost(spent)} this session` : undefined,
      ],
      Predicate.isNotUndefined,
    ),
    " · ",
  );
};
