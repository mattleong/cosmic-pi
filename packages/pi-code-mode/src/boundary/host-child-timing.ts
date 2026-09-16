/** Process-local live timing. Serialized tokens cannot resume clocks during replay. */
import { invokeHostCallback, synchronousNow } from "pi-cosmic-core";
import type { CodeModeCallEntry, LiveChildTiming } from "../tools/format.ts";

const starts = new WeakMap<LiveChildTiming, number>();
const validTime = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

/** The enclosing execution owns all tokens and revokes them on every exit path. No timers. */
export const makeChildTimings = (now: () => number = synchronousNow) => {
  const owned = new Set<LiveChildTiming>();
  let closed = false;
  const stop = (token: LiveChildTiming | undefined) => {
    if (token === undefined || !owned.delete(token)) return;
    starts.delete(token);
  };
  return {
    start: (): LiveChildTiming | undefined => {
      if (closed) return undefined;
      const startedAt = invokeHostCallback(now, undefined);
      if (!validTime(startedAt)) return undefined;
      const token = Object.freeze({ _tag: "CodeModeLiveTiming" as const });
      starts.set(token, startedAt);
      owned.add(token);
      return token;
    },
    stop,
    close: () => {
      closed = true;
      for (const token of owned) stop(token);
    },
  };
};

/** Capture one frame's clock at the host boundary; the pure projector only reads elapsed values. */
export const liveChildElapsed = (now: () => number = synchronousNow) => {
  const current = invokeHostCallback(now, undefined);
  return (call: CodeModeCallEntry): number | undefined => {
    if (!validTime(current) || call.status !== "running" || call.liveTiming === undefined)
      return undefined;
    const startedAt = starts.get(call.liveTiming);
    return startedAt === undefined ? undefined : Math.max(0, current - startedAt);
  };
};
