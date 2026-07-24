import type {
  BackgroundJobSnapshot,
  BackgroundJobView,
  BackgroundTerminalProjection,
} from "./model.ts";
import { isActiveJobState } from "./model.ts";

export const emptyProjection = (): BackgroundTerminalProjection => ({ revision: 0, jobs: [] });

export function sortJobSnapshots(
  jobs: ReadonlyArray<BackgroundJobSnapshot>,
): ReadonlyArray<BackgroundJobSnapshot> {
  return [...jobs].sort((left, right) => {
    const active = Number(isActiveJobState(right.state)) - Number(isActiveJobState(left.state));
    return active !== 0 ? active : right.startedAt - left.startedAt;
  });
}

export function sortJobViews(
  jobs: ReadonlyArray<BackgroundJobView>,
): ReadonlyArray<BackgroundJobView> {
  return [...jobs].sort((left, right) => {
    const active = Number(isActiveJobState(right.state)) - Number(isActiveJobState(left.state));
    return active !== 0 ? active : right.startedAt - left.startedAt;
  });
}

export function footerStatus(projection: BackgroundTerminalProjection): string | undefined {
  const running = projection.jobs.filter((job) => isActiveJobState(job.state)).length;
  const failed = projection.jobs.filter(
    (job) => job.state === "failed" || job.state === "timed_out",
  ).length;
  if (running === 0 && failed === 0) return undefined;
  return `bg: ${running} running${failed > 0 ? ` · ${failed} failed` : ""}`;
}
