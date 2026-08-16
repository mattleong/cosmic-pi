import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { synchronousNow } from "../boundary/native-clock.ts";
import { MAX_PROGRESS_ENTRIES } from "./format.ts";

export const CODE_MODE_SPINNER_INTERVAL_MS = 160;

type StartUiTicker = (intervalMs: number, tick: () => void) => () => void;

interface CodeModeRendererState {
  piCodeModeProgressTicker?: (() => void) | undefined;
  piCodeModeProgressInvalidate?: (() => void) | undefined;
}

export interface CodeModeAnimationContext {
  readonly state?: unknown;
  readonly invalidate?: (() => void) | undefined;
}

const rendererState = (
  context: CodeModeAnimationContext | undefined,
): CodeModeRendererState | undefined => {
  try {
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    return hasObjectRuntimeType(context?.state) &&
      context.state !== null &&
      Predicate.isFunction(context.invalidate)
      ? (context.state as CodeModeRendererState)
      : undefined;
  } catch {
    return undefined;
  }
};

/** True only when a bounded visible nested-call row is currently running. */
export const hasRunningCodeModeCall = <Details>(details: Details): boolean => {
  try {
    if (!hasObjectRuntimeType(details) || details === null) return false;
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    const calls = (details as { readonly toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(calls)) return false;
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    return calls
      .slice(0, MAX_PROGRESS_ENTRIES)
      .some(
        (entry) =>
          hasObjectRuntimeType(entry) &&
          entry !== null &&
          (entry as { readonly status?: unknown }).status === "running",
      );
  } catch {
    return false;
  }
};

/** Fail-soft controller preflight that keeps hostile `result.details` getters contained. */
export const shouldAnimateCodeModeResult = <Result>(
  isPartial: boolean,
  result: Result,
): boolean => {
  if (!isPartial) return false;
  try {
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    return (
      hasObjectRuntimeType(result) &&
      result !== null &&
      hasRunningCodeModeCall((result as { readonly details?: unknown }).details)
    );
  } catch {
    return false;
  }
};

/** Current shared-width Braille frame index. The renderer remains pure by receiving this value. */
export const codeModeAnimationFrame = (now: number = synchronousNow()): number =>
  Math.floor(Math.max(0, now) / CODE_MODE_SPINNER_INTERVAL_MS);

/**
 * Owns one weak, idempotently cancelled host invalidation ticker in Pi's per-tool renderer state.
 * Final/non-running renders stop it; a collected renderer state also stops its orphaned ticker.
 */
const syncCodeModeProgressTickerUnsafe = (
  shouldAnimate: boolean,
  context: CodeModeAnimationContext | undefined,
  startTicker: StartUiTicker,
): void => {
  const state = rendererState(context);
  if (!state) return;
  if (shouldAnimate) {
    state.piCodeModeProgressInvalidate = context?.invalidate;
    if (state.piCodeModeProgressTicker) return;
    const weakState = new WeakRef(state);
    let stopTimer = () => {};
    const cleanup = () => {
      try {
        stopTimer();
      } catch {
        // Renderer teardown is best effort while the host tool row is settling.
      }
    };
    try {
      stopTimer = startTicker(CODE_MODE_SPINNER_INTERVAL_MS, () => {
        const active = weakState.deref();
        if (active) active.piCodeModeProgressInvalidate?.();
        else cleanup();
      });
      state.piCodeModeProgressTicker = cleanup;
    } catch {
      state.piCodeModeProgressInvalidate = undefined;
    }
    return;
  }

  const stop = state.piCodeModeProgressTicker;
  if (!stop) return;
  state.piCodeModeProgressTicker = undefined;
  state.piCodeModeProgressInvalidate = undefined;
  try {
    stop();
  } catch {
    // Renderer teardown is best effort while the host tool row is settling.
  }
};

/** Hostile persisted details or renderer state must never escape into Pi's generic fallback. */
export const syncCodeModeProgressTicker = (
  shouldAnimate: boolean,
  context: CodeModeAnimationContext | undefined,
  startTicker: StartUiTicker,
): void => {
  try {
    syncCodeModeProgressTickerUnsafe(shouldAnimate, context, startTicker);
  } catch {
    // Animation is optional presentation; Code Mode's custom result renderer remains authoritative.
  }
};
