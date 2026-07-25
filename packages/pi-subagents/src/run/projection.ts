import type { SubagentProjection, SubagentRunView } from "./model.ts";
import { isActiveRunState } from "./model.ts";

export const emptyProjection = (): SubagentProjection => ({ revision: 0, runs: [] });

export const sortRuns = (runs: ReadonlyArray<SubagentRunView>): ReadonlyArray<SubagentRunView> =>
  [...runs].sort((left, right) => {
    const activeDifference =
      Number(isActiveRunState(right.state)) - Number(isActiveRunState(left.state));
    if (activeDifference !== 0) return activeDifference;
    return right.startedAt - left.startedAt;
  });

export const fleetStatus = (projection: SubagentProjection): string | undefined => {
  const active = projection.runs.filter((run) => isActiveRunState(run.state)).length;
  const waiting = projection.runs.filter((run) => run.state === "waiting_for_parent").length;
  if (active === 0) return undefined;
  return `agents: ${active} active${waiting ? ` · ${waiting} waiting` : ""}`;
};
