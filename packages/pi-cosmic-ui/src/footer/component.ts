import { basename, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import type {
  CosmicFooterContribution,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol.ts";
import { formatGitStatus, type FooterGitStatus } from "./git.ts";
import {
  combineSurface,
  formatTokens,
  isTerminalImageLine,
  renderContextLine,
  renderContributionLine,
  renderOpenAIUsageLine,
} from "./layout.ts";
import type { FooterContributionRegistry } from "./registry.ts";

export interface FooterTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function abbreviateHomePath(
  path: string,
  home = process.env.HOME || process.env.USERPROFILE,
) {
  if (!home) return path;
  if (path === home) return "~";
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

function sanitizeStatus(text: string) {
  return text.replace(/[ \r\n\t]+/g, " ").trim();
}

function builtinContributions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  totals: FooterTotals,
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>,
  gitStatus: FooterGitStatus | undefined,
): CosmicFooterTextContribution[] {
  const location = abbreviateHomePath(ctx.sessionManager.getCwd());
  const branch = footerData.getGitBranch();
  const sessionName = ctx.sessionManager.getSessionName();

  const subscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = contextUsage?.percent;
  const contextText =
    percent === null || percent === undefined
      ? `?/${formatTokens(contextWindow)}`
      : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;

  const model = ctx.model;
  let modelText = model?.id ?? "no-model";
  const thinking = pi.getThinkingLevel();
  if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && model)
    modelText = `(${model.provider}) ${modelText}`;

  const result: CosmicFooterTextContribution[] = [
    {
      kind: "text",
      id: "model",
      region: "identity",
      text: modelText,
      compactText: model?.id ?? "no-model",
      tone: "normal",
      priority: 100,
      order: 0,
    },
    ...(model?.reasoning
      ? [
          {
            kind: "text" as const,
            id: "effort",
            region: "identity" as const,
            text: thinking === "off" ? "thinking off" : thinking,
            tone: "accent" as const,
            priority: 95,
            order: 100,
          },
        ]
      : []),
    {
      kind: "text",
      id: "location",
      region: "identity",
      text: location,
      compactText: basename(location),
      tone: "accent",
      priority: 100,
      order: 200,
    },
    {
      kind: "text",
      id: "context",
      region: "metrics",
      text: contextText,
      priority: 100,
      order: 0,
    },
  ];
  if (branch)
    result.push({
      kind: "text",
      id: "branch",
      region: "identity",
      text: branch,
      tone: "accent",
      priority: 90,
      order: 200,
    });
  if (gitStatus) {
    const dirty =
      gitStatus.staged + gitStatus.modified + gitStatus.untracked + gitStatus.conflicts > 0;
    result.push({
      kind: "text",
      id: "git",
      region: "identity",
      text: formatGitStatus(gitStatus),
      tone: gitStatus.conflicts ? "error" : dirty ? "warning" : "success",
      priority: 80,
      order: 300,
    });
    const lineStats: string[] = [];
    if (gitStatus.linesAdded) lineStats.push(`+${gitStatus.linesAdded}L`);
    if (gitStatus.linesRemoved) lineStats.push(`-${gitStatus.linesRemoved}L`);
    if (gitStatus.linesChanged) lineStats.push(`~${gitStatus.linesChanged}L`);
    if (lineStats.length)
      result.push({
        kind: "text",
        id: "git.lines",
        region: "identity",
        text: lineStats.join(" "),
        priority: 75,
        order: 310,
      });
  }
  if (sessionName)
    result.push({
      kind: "text",
      id: "session",
      region: "metrics",
      text: sessionName,
      tone: "accent",
      priority: 80,
      order: 100,
    });
  const metricValues = [
    totals.input
      ? { id: "metrics.input", text: `↑${formatTokens(totals.input)}`, order: 200 }
      : undefined,
    totals.output
      ? { id: "metrics.output", text: `↓${formatTokens(totals.output)}`, order: 210 }
      : undefined,
    totals.cacheRead
      ? { id: "metrics.cacheRead", text: `R${formatTokens(totals.cacheRead)}`, order: 220 }
      : undefined,
    totals.cacheWrite
      ? { id: "metrics.cacheWrite", text: `W${formatTokens(totals.cacheWrite)}`, order: 230 }
      : undefined,
    totals.cost || subscription
      ? {
          id: "metrics.cost",
          text: `$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`,
          order: 240,
        }
      : undefined,
  ].filter((value): value is { id: string; text: string; order: number } => Boolean(value));
  for (const metric of metricValues)
    result.push({
      kind: "text",
      id: metric.id,
      region: "metrics",
      text: metric.text,
      priority: 90,
      order: metric.order,
    });
  const statuses = [...footerData.getExtensionStatuses().entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatus(text))
    .filter(Boolean)
    .join(" ");
  if (statuses)
    result.push({
      kind: "text",
      id: "extensions",
      region: "details",
      text: statuses,
      priority: 20,
      order: 1000,
    });
  return result;
}

function ordered(
  values: CosmicFooterTextContribution[],
  config: ResolvedCosmicUiConfig,
): CosmicFooterTextContribution[] {
  const order = new Map(config.footer.order.map((id, index) => [id, index]));
  return values
    .filter(
      (value) =>
        !config.footer.hidden.includes(value.id) &&
        !(value.id.startsWith("metrics.") && config.footer.hidden.includes("metrics")) &&
        !(value.id.startsWith("git.") && config.footer.hidden.includes("git")),
    )
    .sort((a, b) => (order.get(a.id) ?? a.order ?? 500) - (order.get(b.id) ?? b.order ?? 500));
}

export function createFooterComponent(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  footerData: ReadonlyFooterDataProvider;
  theme: CosmicFooterTheme;
  registry: FooterContributionRegistry;
  config(): ResolvedCosmicUiConfig;
  totals(): FooterTotals;
  gitStatus(): FooterGitStatus | undefined;
}) {
  const { pi, ctx, footerData, theme, registry } = options;
  let contextUsageCached = false;
  let cachedContextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  let cachedLeafId: string | null | undefined;
  let cachedModel = ctx.model;

  function invalidateContextUsage(): void {
    contextUsageCached = false;
    cachedContextUsage = undefined;
    cachedLeafId = undefined;
    cachedModel = undefined;
  }

  function contextUsage(): ReturnType<ExtensionContext["getContextUsage"]> {
    const leafId = ctx.sessionManager.getLeafId();
    if (!contextUsageCached || leafId !== cachedLeafId || ctx.model !== cachedModel) {
      cachedContextUsage = ctx.getContextUsage();
      contextUsageCached = true;
      cachedLeafId = leafId;
      cachedModel = ctx.model;
    }
    return cachedContextUsage;
  }

  return {
    invalidate() {
      invalidateContextUsage();
      registry.invalidate();
    },
    invalidateContextUsage,
    render(width: number): string[] {
      if (width <= 0) return [];
      const config = options.config();
      const currentContextUsage = contextUsage();
      const contributions: CosmicFooterContribution[] = [
        ...builtinContributions(
          pi,
          ctx,
          footerData,
          options.totals(),
          currentContextUsage,
          options.gitStatus(),
        ),
        ...registry.list(),
      ];
      const text = ordered(
        contributions.filter(
          (entry): entry is CosmicFooterTextContribution => entry.kind === "text",
        ),
        config,
      );
      const compact =
        config.footer.density === "compact" || (config.footer.density === "auto" && width < 72);
      const identity = text.filter((entry) => entry.region === "identity");
      const metrics = text.filter((entry) => entry.region === "metrics");
      const contextVisible = metrics.some((entry) => entry.id === "context");
      const sessionInfo = metrics.filter((entry) => entry.id !== "context");
      const details = text.filter((entry) => entry.region === "details");
      const openAIUsage = details.find((entry) => entry.id === "openai.usage");
      const otherDetails = details.filter((entry) => entry.id !== "openai.usage");
      let lines: string[] = [];
      if (width < 48) {
        const essentials = identity.filter(
          (entry) =>
            entry.id === "model" ||
            entry.id === "effort" ||
            entry.id === "branch" ||
            entry.id === "git",
        );
        if (essentials.length) lines.push(renderContributionLine(essentials, width, theme, true));
      } else if (identity.length) {
        lines.push(renderContributionLine(identity, width, theme, compact));
      }
      if (contextVisible || sessionInfo.length)
        lines.push(
          contextVisible
            ? renderContextLine(currentContextUsage, sessionInfo, width, theme, compact)
            : renderContributionLine(sessionInfo, width, theme, compact),
        );
      if (openAIUsage)
        lines.push(
          renderOpenAIUsageLine(
            compact && openAIUsage.compactText ? openAIUsage.compactText : openAIUsage.text,
            width,
            theme,
            compact,
          ),
        );
      if (!compact) {
        for (const detail of otherDetails)
          lines.push(renderContributionLine([detail], width, theme, false));
      } else if (otherDetails.length && width >= 64) {
        lines.push(renderContributionLine(otherDetails, width, theme, true));
      }
      const surface = registry.surfaces().find((entry) => !config.footer.hidden.includes(entry.id));
      if (surface) {
        const requestedPlacement =
          config.footer.mediaPlacement ?? surface.preferredPlacement ?? "inline-right";
        const placement =
          requestedPlacement !== "stacked" &&
          requestedPlacement !== "habitat" &&
          width < surface.preferredWidth + 32
            ? "stacked"
            : requestedPlacement;
        const surfaceWidth =
          placement === "stacked" || placement === "habitat"
            ? width
            : Math.min(surface.preferredWidth, Math.max(1, width - 20));
        try {
          const surfaceLines = surface.render({ width: surfaceWidth, placement, theme });
          lines = combineSurface(surfaceLines, lines, width, placement, surfaceWidth);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[pi-cosmic-ui] Failed to render footer surface ${surface.id}: ${message}`);
        }
      }
      return lines.map((line) =>
        isTerminalImageLine(line) ? line : truncateToWidth(line, width, ""),
      );
    },
  };
}
