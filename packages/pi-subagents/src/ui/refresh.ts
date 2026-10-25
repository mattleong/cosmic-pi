import * as Arr from "effect/Array";
import { SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import type { SubagentRunState } from "../run/model.ts";

export type SubagentUiRefreshCadence = typeof SPINNER_FRAME_MS | 1_000;

interface SubagentUiRefreshOptions {
  readonly includePausedElapsed?: boolean;
}

export const subagentUiRefreshCadence = (
  runs: ReadonlyArray<{ readonly state: SubagentRunState }>,
  options: SubagentUiRefreshOptions = {},
): SubagentUiRefreshCadence | undefined => {
  if (Arr.some(runs, (run) => run.state === "starting" || run.state === "running"))
    return SPINNER_FRAME_MS;
  if (
    Arr.some(
      runs,
      (run) =>
        run.state === "waiting_for_parent" ||
        run.state === "stopping" ||
        (options.includePausedElapsed === true && run.state === "paused"),
    )
  )
    return 1_000;
  return undefined;
};
