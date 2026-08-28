import type { SubagentRunState } from "../run/model.ts";

export type SubagentUiRefreshCadence = 160 | 1_000;

export interface SubagentUiRefreshOptions {
  /** Paused elapsed time is live in the persistent activity panel. */
  readonly includePausedElapsed?: boolean;
  /** Completed and retained relative ages are live in the full fleet manager. */
  readonly includeTerminalAges?: boolean;
}

/** Selects the slowest sufficient repaint cadence for the visible run projection. */
export const subagentUiRefreshCadence = (
  runs: ReadonlyArray<{ readonly state: SubagentRunState }>,
  options: SubagentUiRefreshOptions = {},
): SubagentUiRefreshCadence | undefined => {
  if (runs.some((run) => run.state === "starting" || run.state === "running")) return 160;
  if (
    runs.some(
      (run) =>
        run.state === "waiting_for_parent" ||
        run.state === "stopping" ||
        (options.includePausedElapsed === true && run.state === "paused") ||
        (options.includeTerminalAges === true &&
          (run.state === "reported" || run.state === "completed")),
    )
  )
    return 1_000;
  return undefined;
};
