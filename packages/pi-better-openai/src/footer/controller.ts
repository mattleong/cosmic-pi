import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { isFastActive, statusSegment, type FastSnapshot } from "../fast-controller.ts";
import { abbreviateHomePath } from "../footer-layout.ts";
import { formatTokens, sanitizeStatusText, truncateToWidth, visibleWidth } from "../format.ts";
import { STATUS_KEY } from "../identity.ts";
import * as MutableRef from "effect/MutableRef";
import { visibleStatusLine, type OpenAIProjection } from "../usage-controller.ts";

export interface FooterController {
  readonly installed: boolean;
  update(ctx: ExtensionContext): void;
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
  let statusInstalled = false;
  let contextUsageCached = false;
  let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  let cachedContextLeafId: string | null | undefined;
  let cachedContextModel: ExtensionContext["model"];
  let sessionNameCached = false;
  let cachedSessionNameLeafId: string | null | undefined;
  let cachedSessionName: string | undefined;
  let currentContext: ExtensionContext | undefined;

  function refreshFooterTotals(ctx: ExtensionContext): void {
    footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      footerTotals.input += entry.message.usage.input;
      footerTotals.output += entry.message.usage.output;
      footerTotals.cacheRead += entry.message.usage.cacheRead;
      footerTotals.cacheWrite += entry.message.usage.cacheWrite;
      footerTotals.cost += entry.message.usage.cost.total;
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
      cachedContextUsage = ctx.getContextUsage();
      contextUsageCached = true;
      cachedContextLeafId = leafId;
      cachedContextModel = model;
    }
    return cachedContextUsage;
  }

  function sessionName(ctx: ExtensionContext): string | undefined {
    const leafId = ctx.sessionManager.getLeafId();
    if (!sessionNameCached || leafId !== cachedSessionNameLeafId) {
      cachedSessionName = ctx.sessionManager.getSessionName();
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

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      requestFooterRender?.();
      return;
    }
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange?.(requestFooterRender);
      return {
        dispose: () => {
          unsubscribe?.();
          footerInstalled = false;
          requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const renderContext = currentContext ?? ctx;
          const parts: string[] = [];
          if (footerTotals.input) parts.push(`↑${formatTokens(footerTotals.input)}`);
          if (footerTotals.output) parts.push(`↓${formatTokens(footerTotals.output)}`);
          if (footerTotals.cacheRead) parts.push(`R${formatTokens(footerTotals.cacheRead)}`);
          if (footerTotals.cacheWrite) parts.push(`W${formatTokens(footerTotals.cacheWrite)}`);

          const usingSubscription = renderContext.model
            ? renderContext.modelRegistry.isUsingOAuth(renderContext.model)
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
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
    requestFooterRender = undefined;
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    statusInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    currentContext = ctx;
    const cfg = config(ctx);
    if (!hasTerminalUI(ctx)) {
      if (cfg.footer.mode === "off") {
        setStatus(ctx, undefined);
        return;
      }
      const fast = statusSegment(ctx, MutableRef.get(fastProjection));
      const usage = visibleStatusLine(ctx, cfg, projection);
      setStatus(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
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

    const fast = statusSegment(ctx, MutableRef.get(fastProjection));
    const usage = visibleStatusLine(ctx, cfg, projection);
    setStatus(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
  }

  function addAssistantUsage(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  }): void {
    footerTotals.input += usage.input;
    footerTotals.output += usage.output;
    footerTotals.cacheRead += usage.cacheRead;
    footerTotals.cacheWrite += usage.cacheWrite;
    footerTotals.cost += usage.cost.total;
  }

  return {
    get installed() {
      return footerInstalled;
    },
    update: updateFooter,
    refreshTotals: refreshFooterTotals,
    addAssistantUsage,
    invalidateContextUsage,
    invalidateSessionName,
  };
}
