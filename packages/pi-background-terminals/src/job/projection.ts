import type { BackgroundJobSnapshot, BackgroundTerminalProjection } from "./model.ts";
import { isActiveJobState } from "./model.ts";

export const emptyProjection = (): BackgroundTerminalProjection => ({ revision: 0, jobs: [] });

/** Active jobs first, then most recently started. Shared by snapshot and view ordering. */
export function sortJobsByActivity<A extends Pick<BackgroundJobSnapshot, "state" | "startedAt">>(
  jobs: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return [...jobs].sort((left, right) => {
    const active = Number(isActiveJobState(right.state)) - Number(isActiveJobState(left.state));
    return active !== 0 ? active : right.startedAt - left.startedAt;
  });
}

export function footerStatus(projection: BackgroundTerminalProjection): string | undefined {
  const active = projection.jobs.filter((job) => isActiveJobState(job.state)).length;
  const failed = projection.jobs.filter(
    (job) => job.state === "failed" || job.state === "timed_out",
  ).length;
  if (active === 0 && failed === 0) return undefined;
  if (active === 0) return `${failed} background job${failed === 1 ? "" : "s"} failed`;
  return `${active} background job${active === 1 ? "" : "s"} active${failed > 0 ? ` · ${failed} failed` : ""}`;
}
