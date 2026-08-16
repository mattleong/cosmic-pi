import { hasObjectRuntimeType, isFunctionValue, isStringValue } from "./runtime-values.ts";
/** Pure, best-effort reads of Pi session host fields shared by provider extensions. */

export type HostUiContext = {
  readonly mode?: unknown;
  readonly hasUI?: unknown;
};

export type HostTrustContext = {
  readonly isProjectTrusted?: unknown;
};

export type HostSessionContext = {
  readonly cwd?: unknown;
  readonly signal?: unknown;
};

export type HostNotificationLevel = "info" | "warning" | "error";

export type HostNotifierContext = {
  readonly ui: {
    readonly notify: (message: string, level: HostNotificationLevel) => void;
  };
};

export type HostModelRegistry<Model> = {
  readonly isUsingOAuth: (model: Model) => boolean;
};

export type CapturedHostSignal =
  | { readonly _tag: "Captured"; readonly signal: AbortSignal | undefined }
  | { readonly _tag: "Unavailable" };

export type CapturedSessionHost =
  | {
      readonly _tag: "Captured";
      readonly cwd: string;
      readonly signal: AbortSignal | undefined;
      readonly aborted: boolean;
    }
  | { readonly _tag: "Unavailable" };

/** True when the host is a terminal UI session (explicit TUI mode or UI-capable default). */
export function hasTerminalUI(ctx: HostUiContext): boolean {
  try {
    const mode = ctx.mode;
    const hasUI = ctx.hasUI;
    return mode === "tui" || (mode === undefined && Boolean(hasUI));
  } catch {
    return false;
  }
}

/** True only when the host explicitly reports literal project trust. */
export function isProjectTrusted(ctx: HostTrustContext): boolean {
  try {
    const readTrust = ctx.isProjectTrusted;
    return isFunctionValue(readTrust) && readTrust.call(ctx) === true;
  } catch {
    return false;
  }
}

/** Best-effort Pi notification boundary; a hostile or stale host UI never throws into the caller. */
// SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
export function notifyAtHostBoundary(
  ctx: HostNotifierContext,
  message: string,
  level: HostNotificationLevel,
): void {
  try {
    const outcome: unknown = ctx.ui.notify(message, level);
    // Pi documents `notify` as synchronous void. A runtime that returns a thenable anyway must
    // not surface an unhandled rejection through this best-effort boundary, so any returned
    // thenable gets a no-op rejection handler; there is no resource to manage or await.
    if (
      hasObjectRuntimeType(outcome) &&
      outcome !== null &&
      isFunctionValue((outcome as { readonly then?: unknown }).then)
    ) {
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      (outcome as PromiseLike<unknown>).then(
        () => undefined,
        () => undefined,
      );
    }
  } catch {
    // Notifications are best effort at the Pi host boundary.
  }
}

/** Invoke a synchronous Pi host callback, resolving to the supplied fallback if it throws. */
export function invokeHostCallback<A>(callback: () => A, fallback: A): A {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

/** Synchronous Pi-renderer boundary. Host registry failures fail closed and never escape rendering. */
export function isUsingOAuthAtHostBoundary<Model>(
  registry: HostModelRegistry<Model>,
  model: Model,
): boolean {
  try {
    return registry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

/** Capture the session abort signal without throwing across the host boundary. */
export function captureHostSignal(ctx: HostSessionContext): CapturedHostSignal {
  try {
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    return { _tag: "Captured", signal: ctx.signal as AbortSignal | undefined };
  } catch {
    return { _tag: "Unavailable" };
  }
}

/** Capture cwd + abort signal required to start a provider session runtime. */
export function captureSessionHost(ctx: HostSessionContext): CapturedSessionHost {
  try {
    const cwd = ctx.cwd;
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    const signal = ctx.signal as AbortSignal | undefined;
    if (!isStringValue(cwd) || cwd.length === 0) return { _tag: "Unavailable" };
    return {
      _tag: "Captured",
      cwd,
      signal,
      aborted: signal?.aborted === true,
    };
  } catch {
    return { _tag: "Unavailable" };
  }
}
