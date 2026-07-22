import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config/index.ts";
import { isModelUsingOAuth } from "../boundary/model-registry.ts";
import { isFastActive, statusSegment, type FastSnapshot } from "../fast/controller.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as MutableRef from "effect/MutableRef";
import { formatTokens } from "pi-cosmic-core";
import { visibleStatusLine, type OpenAIProjection } from "../usage/index.ts";

const sanitizeStatusText = (text: string) => text.replace(/[ \r\n\t]+/g, " ").trim();

/** Abbreviates conventional Unix home paths without consulting process globals. */
export function abbreviateHomePath(cwd: string): string {
  return cwd.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

export interface FooterController {
  readonly installed: boolean;
  update(ctx: ExtensionContext): void;
  resetTotals(): void;
  refreshTotals(ctx: ExtensionContext): void;
  addAssistantUsage(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  }): void;
  invalidateContextUsage(): void;
  invalidateSessionName(): void;
}

export function createFooterController(deps: {
  pi: ExtensionAPI;
  config(ctx: ExtensionContext): ResolvedConfig;
  fastProjection: MutableRef.MutableRef<FastSnapshot>;
  projection: MutableRef.MutableRef<OpenAIProjection>;
  hasTerminalUI(ctx: ExtensionContext): boolean;
}): FooterController {
  const { pi, config, fastProjection, projection, hasTerminalUI } = deps;
  let footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let footerInstalled = false;
  let requestFooterRender: (() => void) | undefined;
  type FooterInstallToken = {
    disposed: boolean;
    requestRender: (() => void) | undefined;
    readonly cleanups: Set<() => void>;
  };
  let activeFooterToken: FooterInstallToken | undefined;
  let clearingFooterToken: FooterInstallToken | undefined;
  let statusInstalled = false;
  let contextUsageCached = false;
  let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  let cachedContextLeafId: string | null | undefined;
  let cachedContextModel: ExtensionContext["model"];
  let sessionNameCached = false;
  let cachedSessionNameLeafId: string | null | undefined;
  let cachedSessionName: string | undefined;
  let currentContext: ExtensionContext | undefined;

  function resetFooterTotals(): void {
    footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  }

  function refreshFooterTotals(ctx: ExtensionContext): void {
    try {
      const next = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        next.input += entry.message.usage.input;
        next.output += entry.message.usage.output;
        next.cacheRead += entry.message.usage.cacheRead;
        next.cacheWrite += entry.message.usage.cacheWrite;
        next.cost += entry.message.usage.cost.total;
      }
      footerTotals = next;
    } catch {
      // Session data is host-owned. Keep the last complete snapshot when it is unavailable.
    }
  }

  function invalidateContextUsage(): void {
    contextUsageCached = false;
    cachedContextUsage = undefined;
    cachedContextLeafId = undefined;
    cachedContextModel = undefined;
  }

  function contextUsage(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> {
    const leafId = ctx.sessionManager.getLeafId();
    const model = ctx.model;
    if (!contextUsageCached || leafId !== cachedContextLeafId || model !== cachedContextModel) {
      const next = ctx.getContextUsage();
      const materialized = next
        ? {
            ...next,
            contextWindow: next.contextWindow,
            percent: next.percent,
          }
        : undefined;
      cachedContextUsage = materialized;
      contextUsageCached = true;
      cachedContextLeafId = leafId;
      cachedContextModel = model;
    }
    return cachedContextUsage;
  }

  function sessionName(ctx: ExtensionContext): string | undefined {
    const leafId = ctx.sessionManager.getLeafId();
    if (!sessionNameCached || leafId !== cachedSessionNameLeafId) {
      const next = ctx.sessionManager.getSessionName();
      cachedSessionName = next;
      cachedSessionNameLeafId = leafId;
      sessionNameCached = true;
    }
    return cachedSessionName;
  }

  function invalidateSessionName(): void {
    sessionNameCached = false;
    cachedSessionNameLeafId = undefined;
    cachedSessionName = undefined;
  }

  function resetFooterOwnership(): void {
    activeFooterToken = undefined;
    footerInstalled = false;
    requestFooterRender = undefined;
  }

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      if (!activeFooterToken?.disposed) {
        try {
          requestFooterRender?.();
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
          requestFooterRender = safeRequestRender;
          try {
            const cleanupBranch = footerData.onBranchChange?.(safeRequestRender);
            if (typeof cleanupBranch === "function") unsubscribe = cleanupBranch;
          } catch {
            // A branch subscription failure does not invalidate an otherwise usable footer.
          }
        };
        if (accepted) activate();
        else if (!token.disposed) pendingActivations.add(activate);

        const renderDetailed = (width: number): string[] => {
          if (!Number.isFinite(width) || width <= 0) return [];
          const renderContext = currentContext ?? ctx;
          const parts: string[] = [];
          if (footerTotals.input) parts.push(`↑${formatTokens(footerTotals.input)}`);
          if (footerTotals.output) parts.push(`↓${formatTokens(footerTotals.output)}`);
          if (footerTotals.cacheRead) parts.push(`R${formatTokens(footerTotals.cacheRead)}`);
          if (footerTotals.cacheWrite) parts.push(`W${formatTokens(footerTotals.cacheWrite)}`);

          const usingSubscription = renderContext.model
            ? isModelUsingOAuth(renderContext, renderContext.model)
            : false;
          if (footerTotals.cost || usingSubscription)
            parts.push(`$${footerTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          const currentContextUsage = contextUsage(renderContext);
          const contextWindow =
            currentContextUsage?.contextWindow ?? renderContext.model?.contextWindow ?? 0;
          const contextPercentValue = currentContextUsage?.percent ?? 0;
          const contextPercent =
            currentContextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
          const contextDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          const contextText =
            contextPercentValue > 90
              ? theme.fg("error", contextDisplay)
              : contextPercentValue > 70
                ? theme.fg("warning", contextDisplay)
                : contextDisplay;
          parts.push(contextText);

          let statsLeft = parts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = renderContext.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const fastActive = isFastActive(renderContext, MutableRef.get(fastProjection));
          let rightWithoutProvider = modelName;
          if (renderContext.model?.reasoning) {
            const effort = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
            rightWithoutProvider = `${modelName} • ${fastActive ? "⚡" : ""}${effort}`;
          } else if (fastActive) {
            rightWithoutProvider = `${modelName} • ⚡`;
          }

          let rightSide = rightWithoutProvider;
          if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && renderContext.model) {
            const withProvider = `(${renderContext.model.provider}) ${rightWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
          }

          const rightWidth = visibleWidth(rightSide);
          let statsLine: string;
          if (statsLeftWidth + 2 + rightWidth <= width) {
            statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              statsLine =
                statsLeft +
                " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) +
                truncatedRight;
            } else statsLine = statsLeft;
          }

          let pwd = abbreviateHomePath(renderContext.sessionManager.getCwd());
          const branch = footerData.getGitBranch?.();
          if (branch) pwd = `${pwd} (${branch})`;
          const currentSessionName = sessionName(renderContext);
          if (currentSessionName) pwd = `${pwd} • ${currentSessionName}`;

          const textLines: string[] = [
            truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
            theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
          ];

          const cfg = config(renderContext);
          const usageStatusLine = visibleStatusLine(
            renderContext,
            cfg,
            projection,
            usingSubscription,
          );
          if (usageStatusLine)
            textLines.push(
              truncateToWidth(theme.fg("dim", usageStatusLine), width, theme.fg("dim", "...")),
            );

          const extensionStatuses = footerData.getExtensionStatuses?.();
          if (extensionStatuses?.size) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => String(a).localeCompare(String(b)))
              .map(([, text]) => sanitizeStatusText(String(text)))
              .join(" ");
            textLines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }
          return textLines;
        };

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
            try {
              return renderDetailed(width);
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
    footerInstalled = true;
    for (const activate of pendingActivations) activate();
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
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
      ctx.ui.setStatus("better-openai", text);
      statusInstalled = text !== undefined;
    } catch {
      // Retain the prior ownership state so a later update retries the mutation.
    }
  }

  function statusText(ctx: ExtensionContext, cfg: ResolvedConfig): string | undefined {
    const fast = statusSegment(ctx, MutableRef.get(fastProjection));
    const usage = visibleStatusLine(ctx, cfg, projection);
    return [fast, usage].filter(Boolean).join(" | ") || undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    currentContext = ctx;
    try {
      const cfg = config(ctx);
      if (!hasTerminalUI(ctx)) {
        if (cfg.footer.mode === "off") {
          setStatus(ctx, undefined);
          return;
        }
        setStatus(ctx, statusText(ctx, cfg));
        return;
      }

      if (cfg.footer.mode === "replace") {
        setStatus(ctx, undefined);
        installFooter(ctx);
        return;
      }

      clearFooter(ctx);
      if (cfg.footer.mode === "off") {
        setStatus(ctx, undefined);
        return;
      }

      setStatus(ctx, statusText(ctx, cfg));
    } catch {
      // Footer/status updates are synchronous host callbacks and must remain total.
    }
  }

  function addAssistantUsage(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  }): void {
    try {
      footerTotals = {
        input: footerTotals.input + usage.input,
        output: footerTotals.output + usage.output,
        cacheRead: footerTotals.cacheRead + usage.cacheRead,
        cacheWrite: footerTotals.cacheWrite + usage.cacheWrite,
        cost: footerTotals.cost + usage.cost.total,
      };
    } catch {
      // Preserve the last complete totals when an event payload is hostile.
    }
  }

  return {
    get installed() {
      return footerInstalled;
    },
    update: updateFooter,
    resetTotals: resetFooterTotals,
    refreshTotals: refreshFooterTotals,
    addAssistantUsage,
    invalidateContextUsage,
    invalidateSessionName,
  };
}
