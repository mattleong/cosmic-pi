import { countLabel } from "pi-cosmic-core";
import type { SubagentProjection, SubagentRunView } from "./model.ts";
import { isActiveRunState } from "./model.ts";

export const emptyProjection = (): SubagentProjection => ({
  revision: 0,
  runs: [],
});

export const sortRuns = (runs: ReadonlyArray<SubagentRunView>): ReadonlyArray<SubagentRunView> =>
  [...runs].sort((left, right) => {
    const activeDifference =
      Number(isActiveRunState(right.state)) - Number(isActiveRunState(left.state));
    if (activeDifference !== 0) return activeDifference;
    return right.startedAt - left.startedAt;
  });

export const fleetStatus = (projection: SubagentProjection): string | undefined => {
  const owned = projection.runs.filter((run) => isActiveRunState(run.state)).length;
  const working = projection.runs.filter(
    (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
  ).length;
  const waiting = projection.runs.filter((run) => run.state === "waiting_for_parent").length;
  const paused = projection.runs.filter((run) => run.state === "paused").length;
  if (owned === 0) return undefined;
  return [
    working ? `${countLabel(working, "subagent")} running` : undefined,
    waiting ? `${waiting} waiting for reply` : undefined,
    paused ? `${paused} paused` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
};
