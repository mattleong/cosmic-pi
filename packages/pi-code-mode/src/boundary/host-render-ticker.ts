/**
 * Hostile Pi renderer-state adapter for the code_mode progress spinner.
 *
 * Pi hands render methods an untyped extension-state object and an invalidate callback; both
 * may be missing, non-object, or hostile (throwing getters, sealed objects, throwing timers).
 * None of that can break a result render: animation is optional presentation, every property
 * access is guarded, and the weak ticker cleans itself up once the state is collected.
 */
import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType, synchronousNow } from "pi-cosmic-core";

const SPINNER_INTERVAL_MS = 160;
type StartUiTicker = (intervalMs: number, tick: () => void) => () => void;
type RendererState = {
  piCodeModeProgressTicker?: (() => void) | undefined;
  piCodeModeProgressInvalidate?: (() => void) | undefined;
};
type RendererContext = {
  readonly state?: unknown;
  readonly invalidate?: (() => void) | undefined;
};

export const syncProgressTicker = (
  shouldAnimate: boolean,
  context: RendererContext | undefined,
  startTicker: StartUiTicker,
): void => {
  try {
    const rawState = context?.state;
    const invalidate = context?.invalidate;
    if (!hasObjectRuntimeType(rawState) || rawState === null || !Predicate.isFunction(invalidate))
      return;
    // SAFETY: Renderer state is host-owned extensible object storage; every property is guarded.
    const state = rawState as RendererState;
    if (!shouldAnimate) {
      let stop: unknown;
      try {
        stop = state.piCodeModeProgressTicker;
        state.piCodeModeProgressTicker = undefined;
        state.piCodeModeProgressInvalidate = undefined;
      } catch {}
      if (Predicate.isFunction(stop))
        try {
          stop();
        } catch {}
      return;
    }
    state.piCodeModeProgressInvalidate = invalidate;
    if (Predicate.isFunction(state.piCodeModeProgressTicker)) return;
    const weakState = new WeakRef(state);
    let stopped = false;
    let stopTimer: () => void = () => undefined;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      try {
        stopTimer();
      } catch {}
    };
    const tick = () => {
      const active = weakState.deref();
      if (!active) return cleanup();
      try {
        active.piCodeModeProgressInvalidate?.();
      } catch {
        try {
          active.piCodeModeProgressTicker = undefined;
          active.piCodeModeProgressInvalidate = undefined;
        } catch {}
        cleanup();
      }
    };
    try {
      const stop = startTicker(SPINNER_INTERVAL_MS, tick);
      if (!Predicate.isFunction(stop)) return cleanup();
      stopTimer = stop;
      if (stopped) {
        try {
          stop();
        } catch {}
        return;
      }
      state.piCodeModeProgressTicker = cleanup;
    } catch {
      try {
        state.piCodeModeProgressInvalidate = undefined;
      } catch {}
      cleanup();
    }
  } catch {
    // Animation is optional presentation.
  }
};

export const animationFrame = (): number => {
  try {
    return Math.floor(Math.max(0, synchronousNow()) / SPINNER_INTERVAL_MS);
  } catch {
    return 0;
  }
};
