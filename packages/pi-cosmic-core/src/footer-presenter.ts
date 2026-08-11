/** Shared host-footer ownership: token-based install/clear, status publication, mode dispatch. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SetFooter = ExtensionContext["ui"]["setFooter"];
type FooterFactory = NonNullable<Parameters<SetFooter>[0]>;
/** Theme handed to the footer factory by the host TUI. */
export type FooterTheme = Parameters<FooterFactory>[1];
/** Host footer data provider (git branch, extension statuses, branch-change signal). */
export type FooterHostData = Parameters<FooterFactory>[2];

export type FooterMode = "replace" | "status" | "off";

export interface FooterPresenter {
  readonly update: (ctx: ExtensionContext) => void;
}

export interface FooterPresenterOptions {
  /** ctx.ui.setStatus key owned by this presenter. */
  readonly statusKey: string;
  readonly footerMode: (ctx: ExtensionContext) => FooterMode;
  readonly hasTerminalUI: (ctx: ExtensionContext) => boolean;
  /** Status-line text published in "status" mode and on non-terminal hosts. */
  readonly statusText: (ctx: ExtensionContext) => string | undefined;
  /**
   * Renders the owned footer's lines. `ctx` is the install-time context; implementations
   * tracking a newer context should read their own state instead. Thrown errors render nothing.
   */
  readonly renderLines: (args: {
    readonly ctx: ExtensionContext;
    readonly theme: FooterTheme;
    readonly footerData: FooterHostData | undefined;
    readonly width: number;
  }) => string[];
}

/**
 * Creates the shared footer/status ownership controller. Ownership is derived solely from the
 * active install token, so host callbacks that throw, dispose reentrantly, or replace the footer
 * while it clears never strand a stale component or lose a live one.
 */
export function createFooterPresenter(options: FooterPresenterOptions): FooterPresenter {
  type FooterInstallToken = {
    disposed: boolean;
    requestRender: (() => void) | undefined;
    readonly cleanups: Set<() => void>;
  };
  let activeFooterToken: FooterInstallToken | undefined;
  let clearingFooterToken: FooterInstallToken | undefined;
  let statusInstalled = false;

  function resetFooterOwnership(): void {
    activeFooterToken = undefined;
  }

  function installFooter(ctx: ExtensionContext): void {
    if (activeFooterToken) {
      if (!activeFooterToken.disposed) {
        try {
          activeFooterToken.requestRender?.();
        } catch {
          // Rendering is a host callback; a failed request does not relinquish ownership.
        }
        return;
      }
      resetFooterOwnership();
    }

    const token: FooterInstallToken = {
      disposed: false,
      requestRender: undefined,
      cleanups: new Set(),
    };
    let accepted = false;
    const pendingActivations = new Set<() => void>();

    try {
      ctx.ui.setFooter((tui, theme, footerData) => {
        let componentDisposed = false;
        let unsubscribe: (() => void) | undefined;
        const safeRequestRender = () => {
          try {
            tui.requestRender();
          } catch {
            // TUI render requests are advisory and must not escape the footer callback.
          }
        };
        const cleanup = () => {
          const cleanupBranch = unsubscribe;
          unsubscribe = undefined;
          token.cleanups.delete(cleanup);
          if (!cleanupBranch) return;
          try {
            cleanupBranch();
          } catch {
            // Branch subscriptions are host-owned; disposal remains total.
          }
        };
        token.cleanups.add(cleanup);
        const activate = () => {
          pendingActivations.delete(activate);
          if (componentDisposed || token.disposed || !accepted || activeFooterToken !== token)
            return;
          token.requestRender = safeRequestRender;
          try {
            const cleanupBranch = footerData?.onBranchChange?.(safeRequestRender);
            if (typeof cleanupBranch === "function") unsubscribe = cleanupBranch;
          } catch {
            // A branch subscription failure does not invalidate an otherwise usable footer.
          }
        };
        if (accepted) activate();
        else if (!token.disposed) pendingActivations.add(activate);

        return {
          dispose: () => {
            if (componentDisposed) return;
            componentDisposed = true;
            pendingActivations.delete(activate);
            cleanup();
            token.disposed = true;
            if (activeFooterToken !== token || clearingFooterToken === token) return;
            resetFooterOwnership();
          },
          invalidate() {},
          render(width: number): string[] {
            if (componentDisposed || token.disposed) return [];
            if (!Number.isFinite(width) || width <= 0) return [];
            try {
              return options.renderLines({ ctx, theme, footerData, width });
            } catch {
              return [];
            }
          },
        };
      });
    } catch {
      token.disposed = true;
      pendingActivations.clear();
      for (const cleanup of token.cleanups) cleanup();
      return;
    }

    accepted = true;
    if (token.disposed) return;
    activeFooterToken = token;
    for (const activate of pendingActivations) activate();
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!activeFooterToken) return;
    const token = activeFooterToken;
    clearingFooterToken = token;
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      if (token?.disposed && activeFooterToken === token) resetFooterOwnership();
      return;
    } finally {
      clearingFooterToken = undefined;
    }
    if (token && activeFooterToken === token) {
      token.disposed = true;
      for (const cleanup of token.cleanups) cleanup();
      resetFooterOwnership();
    }
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    try {
      ctx.ui.setStatus(options.statusKey, text);
      statusInstalled = text !== undefined;
    } catch {
      // Retain the prior ownership state so a later update retries the mutation.
    }
  }

  function update(ctx: ExtensionContext): void {
    try {
      const mode = options.footerMode(ctx);
      if (!options.hasTerminalUI(ctx)) {
        setStatus(ctx, mode === "off" ? undefined : options.statusText(ctx));
        return;
      }

      if (mode === "replace") {
        setStatus(ctx, undefined);
        installFooter(ctx);
        return;
      }

      clearFooter(ctx);
      setStatus(ctx, mode === "off" ? undefined : options.statusText(ctx));
    } catch {
      // Footer/status updates are synchronous host callbacks and must remain total.
    }
  }

  return { update };
}
