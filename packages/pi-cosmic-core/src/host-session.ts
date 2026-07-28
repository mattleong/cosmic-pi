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
    return typeof readTrust === "function" && readTrust.call(ctx) === true;
  } catch {
    return false;
  }
}

/** Capture the session abort signal without throwing across the host boundary. */
export function captureHostSignal(ctx: HostSessionContext): CapturedHostSignal {
  try {
    return { _tag: "Captured", signal: ctx.signal as AbortSignal | undefined };
  } catch {
    return { _tag: "Unavailable" };
  }
}

/** Capture cwd + abort signal required to start a provider session runtime. */
export function captureSessionHost(ctx: HostSessionContext): CapturedSessionHost {
  try {
    const cwd = ctx.cwd;
    const signal = ctx.signal as AbortSignal | undefined;
    if (typeof cwd !== "string" || cwd.length === 0) return { _tag: "Unavailable" };
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
