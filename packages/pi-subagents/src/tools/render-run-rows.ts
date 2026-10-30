import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import { synchronousNow } from "pi-cosmic-core/platform/native-clock";
import { formatSessionActivity, formatSessionAge } from "../ui/run-presentation.ts";

export const runTiming = (run: {
  readonly endedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly startedAt?: number | undefined;
}): string => {
  const now = synchronousNow();
  const elapsed = formatSessionAge(run.endedAt ?? now, run.startedAt);
  const activeAge = run.endedAt === undefined ? formatSessionActivity(now, run.lastActivityAt) : "";
  const active = activeAge ? `active ${activeAge}` : "";
  return Fn.pipe([elapsed, active], Arr.filter(Boolean), Arr.join(" · "));
};

export interface RunHierarchy {
  readonly awaitedRunIds?: ReadonlySet<string> | undefined;
  readonly contextOmitted?: boolean | undefined;
}
