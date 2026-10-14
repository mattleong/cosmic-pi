import * as Data from "effect/Data";
import { constVoid } from "effect/Function";
import * as Predicate from "effect/Predicate";
import { notificationText } from "./message-text.ts";

type HostUiContext = {
  readonly mode?: unknown;
  readonly hasUI?: unknown;
};

type HostTrustContext = {
  readonly isProjectTrusted?: unknown;
};

type HostSessionContext = {
  readonly cwd?: unknown;
  readonly signal?: AbortSignal | undefined;
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

export type CapturedHostSignal = Data.TaggedEnum<{
  Captured: { readonly signal: AbortSignal | undefined };
  Unavailable: Record<never, never>;
}>;
export const CapturedHostSignal = Data.taggedEnum<CapturedHostSignal>();

type CapturedSessionHost = Data.TaggedEnum<{
  Captured: {
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly aborted: boolean;
  };
  Unavailable: Record<never, never>;
}>;
const CapturedSessionHost = Data.taggedEnum<CapturedSessionHost>();

export function hasTerminalUI(ctx: HostUiContext): boolean {
  return invokeHostCallback(() => {
    const mode = ctx.mode;
    const hasUI = ctx.hasUI;
    return mode === "tui" || (mode === undefined && Boolean(hasUI));
  }, false);
}

export function isProjectTrusted(ctx: HostTrustContext): boolean {
  return invokeHostCallback(() => {
    const readTrust = ctx.isProjectTrusted;
    return Predicate.isFunction(readTrust) && readTrust.call(ctx) === true;
  }, false);
}

export function notifyAtHostBoundary(
  ctx: HostNotifierContext,
  message: string,
  level: HostNotificationLevel,
): void {
  const text = notificationText(message);
  invokeBestEffort(() => ctx.ui.notify(text, level));
}

export function invokeBestEffort(callback: () => void): void {
  try {
    const result = callback();
    if (!Predicate.isObjectKeyword(result)) return;
    const candidate: { readonly then?: unknown } = result;
    const then = candidate.then;
    if (Predicate.isFunction(then)) then.call(result, constVoid, constVoid);
  } catch {}
}

export function invokeHostCallback<A>(callback: () => A, fallback: A): A {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

export function isUsingOAuthAtHostBoundary<Model>(
  registry: HostModelRegistry<Model>,
  model: Model,
): boolean {
  return invokeHostCallback(() => registry.isUsingOAuth(model), false);
}

export function captureHostSignal(ctx: HostSessionContext): CapturedHostSignal {
  try {
    return CapturedHostSignal.Captured({ signal: ctx.signal });
  } catch {
    return CapturedHostSignal.Unavailable();
  }
}

export function captureSessionHost(ctx: HostSessionContext): CapturedSessionHost {
  try {
    const cwd = ctx.cwd;
    const signal = ctx.signal;
    if (!Predicate.isString(cwd) || cwd.length === 0) return CapturedSessionHost.Unavailable();
    return CapturedSessionHost.Captured({ cwd, signal, aborted: signal?.aborted === true });
  } catch {
    return CapturedSessionHost.Unavailable();
  }
}
