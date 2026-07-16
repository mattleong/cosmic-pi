import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { STATUS_KEY } from "../identity.ts";
import { formatTokens, sanitizeStatusText, truncateToWidth, visibleWidth } from "../format.ts";
import {
  abbreviateHomePath,
  combineInlinePetFooter,
  isInlinePetPlacement,
  petSizeCellsForPlacement,
} from "../footer-layout.ts";
import { supportsFast, type FastController } from "../fast-controller.ts";
import type { ResolvedConfig } from "../config.ts";
import type { UsageController } from "../usage-controller.ts";
import type { PetFooterController } from "../pet-footer-controller.ts";

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
  fastController: FastController;
  usageController: UsageController;
  petController: PetFooterController;
  hasTerminalUI(ctx: ExtensionContext): boolean;
}): FooterController {
  const { pi, config, fastController, usageController, petController, hasTerminalUI } = deps;
  let footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let footerInstalled = false;
  let statusInstalled = false;
  let contextUsageCached = false;
  let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  let cachedContextLeafId: string | null | undefined;
  let cachedContextModel: ExtensionContext["model"];
  let sessionNameCached = false;
  let cachedSessionNameLeafId: string | null | undefined;
  let cachedSessionName: string | undefined;

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
      petController.requestFooterRenderNow();
      return;
    }
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      petController.setFooterRenderRequest(() => tui.requestRender());
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      let lastFooterSizeKey: string | undefined;
      return {
        dispose: () => {
          unsubscribe?.();
          petController.stopIdleEmotes();
          petController.stopAnimation();
          petController.stopPendingRenderRequest();
          petController.disposeKittyNow();
          footerInstalled = false;
          petController.setFooterRenderRequest(undefined);
        },
        invalidate() {
          petController.queueKittyCleanup();
          petController.resetRenderCache();
        },
        render(width: number): string[] {
          const now = Date.now();
          const footerSizeKey = `${width}:${process.stdout.rows ?? 0}`;
          if (lastFooterSizeKey !== undefined && lastFooterSizeKey !== footerSizeKey) {
            petController.freezeForResize(ctx, now);
          }
          lastFooterSizeKey = footerSizeKey;
          const freezePetFrame = petController.isResizeFrozen(now);

          const totalInput = footerTotals.input;
          const totalOutput = footerTotals.output;
          const totalCacheRead = footerTotals.cacheRead;
          const totalCacheWrite = footerTotals.cacheWrite;
          const totalCost = footerTotals.cost;

          let pwd = abbreviateHomePath(ctx.sessionManager.getCwd());

          const branch = footerData.getGitBranch?.();
          if (branch) pwd = `${pwd} (${branch})`;

          const currentSessionName = sessionName(ctx);
          if (currentSessionName) pwd = `${pwd} • ${currentSessionName}`;

          const parts: string[] = [];
          if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription)
            parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          const currentContextUsage = contextUsage(ctx);
          const contextWindow = currentContextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
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

          const cfg = config(ctx);
          const shouldRenderPet = petController.shouldRenderInFooter(cfg);
          const requestedPetPlacement = cfg.pets.placement;
          const requestedPetSizeCells = petSizeCellsForPlacement(
            requestedPetPlacement,
            cfg.pets.sizeCells,
          );
          const inlinePet = Boolean(
            shouldRenderPet &&
            petController.loadedPet &&
            isInlinePetPlacement(requestedPetPlacement) &&
            width >= requestedPetSizeCells + 32,
          );
          const petRenderSizeCells = inlinePet ? requestedPetSizeCells : cfg.pets.sizeCells;
          const petColumnWidth = Math.min(petRenderSizeCells, Math.max(1, width - 1));
          const footerTextWidth = inlinePet ? Math.max(1, width - petColumnWidth - 2) : width;

          const usageStatusLine = usageController.statusLine(ctx, cfg, usingSubscription);
          const usageLine = usageStatusLine ? theme.fg("dim", usageStatusLine) : undefined;

          let statsLeft = parts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > footerTextWidth) {
            statsLeft = truncateToWidth(statsLeft, footerTextWidth, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const fastSuffix = fastController.active && supportsFast(ctx) ? " fast" : "";
          let rightWithoutProvider = modelName;
          if (ctx.model?.reasoning) {
            rightWithoutProvider =
              thinkingLevel === "off"
                ? `${modelName}${fastSuffix} • thinking off`
                : `${modelName}${fastSuffix} • ${thinkingLevel}`;
          } else if (fastSuffix) {
            rightWithoutProvider = `${modelName}${fastSuffix}`;
          }

          let rightSide = rightWithoutProvider;
          if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= footerTextWidth)
              rightSide = withProvider;
          }

          const rightWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightWidth;
          let statsLine: string;
          if (totalNeeded <= footerTextWidth) {
            statsLine =
              statsLeft + " ".repeat(footerTextWidth - statsLeftWidth - rightWidth) + rightSide;
          } else {
            const availableForRight = footerTextWidth - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              statsLine =
                statsLeft +
                " ".repeat(
                  Math.max(0, footerTextWidth - statsLeftWidth - visibleWidth(truncatedRight)),
                ) +
                truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const textLines: string[] = [
            truncateToWidth(theme.fg("dim", pwd), footerTextWidth, theme.fg("dim", "...")),
            theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
          ];

          if (usageLine) {
            textLines.push(truncateToWidth(usageLine, footerTextWidth, theme.fg("dim", "...")));
          }

          const extensionStatuses = footerData.getExtensionStatuses?.();
          if (extensionStatuses?.size) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => String(a).localeCompare(String(b)))
              .map(([, text]) => sanitizeStatusText(String(text)))
              .join(" ");
            textLines.push(truncateToWidth(statusLine, footerTextWidth, theme.fg("dim", "...")));
          }

          const petLines = petController.renderPetLines(ctx, cfg, {
            shouldRenderPet,
            freezePetFrame,
            requestedPetPlacement,
            petColumnWidth,
            petRenderSizeCells,
            width,
            theme,
          });

          if (!shouldRenderPet || petLines.length === 0)
            return petController.withPendingKittyCleanup(textLines);

          if (inlinePet) {
            return petController.withPendingKittyCleanup(
              combineInlinePetFooter(
                petLines,
                textLines,
                width,
                requestedPetPlacement,
                petColumnWidth,
              ),
            );
          }

          if (requestedPetPlacement === "habitat" && petController.loadedPet) {
            const label = ` ${petController.loadedPet.pet.name} `;
            const divider = theme.fg(
              "dim",
              truncateToWidth(`─${label}${"─".repeat(width)}`, width, ""),
            );
            return petController.withPendingKittyCleanup([divider, ...petLines, ...textLines]);
          }

          return petController.withPendingKittyCleanup([...petLines, ...textLines]);
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    petController.disposeKittyNow();
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
    petController.setFooterRenderRequest(undefined);
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    statusInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    const cfg = config(ctx);

    if (!hasTerminalUI(ctx)) {
      if (cfg.footer.mode === "off") {
        setStatus(ctx, undefined);
        return;
      }
      const fast = fastController.statusSegment(ctx);
      const usage = usageController.statusLine(ctx, cfg);
      setStatus(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
      return;
    }

    petController.updateActivity(ctx, cfg);
    const shouldRenderPet = petController.shouldRenderInFooter(cfg);

    if (cfg.footer.mode === "replace" || shouldRenderPet) {
      setStatus(ctx, undefined);
      installFooter(ctx);
      return;
    }

    clearFooter(ctx);

    if (cfg.footer.mode === "off") {
      setStatus(ctx, undefined);
      return;
    }

    const fast = fastController.statusSegment(ctx);
    const usage = usageController.statusLine(ctx, cfg);
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
