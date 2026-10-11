import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import type { SubagentRunState } from "../run/model.ts";

export type SubagentUiRefreshCadence = typeof SPINNER_FRAME_MS | 1_000;

interface SubagentUiRefreshOptions {
  readonly includePausedElapsed?: boolean;
  readonly includeTerminalAges?: boolean;
}

export const subagentUiRefreshCadence = (
  runs: ReadonlyArray<{ readonly state: SubagentRunState }>,
  options: SubagentUiRefreshOptions = {},
): SubagentUiRefreshCadence | undefined => {
  if (runs.some((run) => run.state === "starting" || run.state === "running"))
    return SPINNER_FRAME_MS;
  if (
    runs.some(
      (run) =>
        run.state === "waiting_for_parent" ||
        run.state === "stopping" ||
        (options.includePausedElapsed === true && run.state === "paused") ||
        (options.includeTerminalAges === true && run.state === "completed"),
    )
  )
    return 1_000;
  return undefined;
};
