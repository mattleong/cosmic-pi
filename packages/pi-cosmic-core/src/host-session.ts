import { constVoid } from "effect/Function";
import * as Predicate from "effect/Predicate";
import { notificationText } from "./message-text.ts";
/** Pure, best-effort reads of Pi session host fields shared by provider extensions. */

type HostUiContext = {
  readonly mode?: unknown;
  readonly hasUI?: unknown;
};

type HostTrustContext = {
  readonly isProjectTrusted?: unknown;
};

type HostSessionContext = {
  readonly cwd?: unknown;
  readonly signal?: unknown;
};

export type HostNotificationLevel = "info" | "warning" | "error";

type HostNotifierContext = {
  readonly ui: {
    readonly notify: (message: string, level: HostNotificationLevel) => void;
  };
};

type HostModelRegistry<Model> = {
  readonly isUsingOAuth: (model: Model) => boolean;
};

export type CapturedHostSignal =
  | { readonly _tag: "Captured"; readonly signal: AbortSignal | undefined }
  | { readonly _tag: "Unavailable" };

type CapturedSessionHost =
  | {
      readonly _tag: "Captured";
      readonly cwd: string;
      readonly signal: AbortSignal | undefined;
      readonly aborted: boolean;
    }
  | { readonly _tag: "Unavailable" };

/** True when the host is a terminal UI session (explicit TUI mode or UI-capable default). */
export function hasTerminalUI(ctx: HostUiContext): boolean {
  return invokeHostCallback(() => {
    const mode = ctx.mode;
    const hasUI = ctx.hasUI;
    return mode === "tui" || (mode === undefined && Boolean(hasUI));
  }, false);
}

/** True only when the host explicitly reports literal project trust. */
export function isProjectTrusted(ctx: HostTrustContext): boolean {
  return invokeHostCallback(() => {
    const readTrust = ctx.isProjectTrusted;
    return Predicate.isFunction(readTrust) && readTrust.call(ctx) === true;
  }, false);
}

/**
 * Best-effort Pi notification boundary; a hostile or stale host UI never throws into the caller.
 * One-line messages are tidied into the shared style; multi-line reports keep their layout.
 */
export function notifyAtHostBoundary(
  ctx: HostNotifierContext,
  message: string,
  level: HostNotificationLevel,
): void {
  const text = notificationText(message);
  // Pi documents `notify` as synchronous void; a returned thenable is contained anyway.
  invokeBestEffort(() => ctx.ui.notify(text, level));
}

/**
 * Attaches no-op settlement handlers to an object or callable thenable, reading `then` exactly
 * once. Inspection failures are contained: there is no resource to manage or await.
 */
function containThenable<Value>(value: Value): void {
  try {
    if (!Predicate.isObjectOrArray(value) && !Predicate.isFunction(value)) return;
    // SAFETY: The value is narrowed to an object or function before its optional then is read.
    const then = (value as { readonly then?: unknown }).then;
    if (Predicate.isFunction(then)) then.call(value, constVoid, constVoid);
  } catch {
    // A hostile thenable cannot escape a best-effort boundary.
  }
}

/** Calls a best-effort host or protocol callback: a throw is swallowed, a thenable contained. */
export function invokeBestEffort<A>(callback: () => A): void {
  try {
    containThenable(callback());
  } catch {
    // Best-effort callbacks cannot escape their boundary.
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
  return invokeHostCallback(() => registry.isUsingOAuth(model), false);
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
    if (!Predicate.isString(cwd) || cwd.length === 0) return { _tag: "Unavailable" };
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
