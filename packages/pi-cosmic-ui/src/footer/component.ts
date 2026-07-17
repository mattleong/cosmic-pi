import { sep } from "node:path";
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
import {
  combineSurface,
  formatTokens,
  isTerminalImageLine,
  renderContributionLine,
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
): CosmicFooterTextContribution[] {
  let location = abbreviateHomePath(ctx.sessionManager.getCwd());
  const branch = footerData.getGitBranch();
  if (branch) location += ` (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) location += ` • ${sessionName}`;

  const metrics: string[] = [];
  if (totals.input) metrics.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) metrics.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) metrics.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) metrics.push(`W${formatTokens(totals.cacheWrite)}`);
  const subscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
  if (totals.cost || subscription)
    metrics.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = contextUsage?.percent;
  const contextText =
    percent === null || percent === undefined
      ? `?/${formatTokens(contextWindow)}`
      : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
  metrics.push(`${contextText} (auto)`);

  const model = ctx.model;
  let modelText = model?.id ?? "no-model";
  const thinking = pi.getThinkingLevel();
  if (model?.reasoning) modelText += thinking === "off" ? " • thinking off" : ` • ${thinking}`;
  if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && model)
    modelText = `(${model.provider}) ${modelText}`;

  const result: CosmicFooterTextContribution[] = [
    { kind: "text", id: "location", region: "identity", text: location, priority: 100, order: 0 },
    {
      kind: "text",
      id: "model",
      region: "identity",
      text: modelText,
      compactText: model?.id ?? "no-model",
      align: "right",
      priority: 100,
      order: 100,
    },
    {
      kind: "text",
      id: "metrics",
      region: "metrics",
      text: metrics.join(" "),
      compactText: contextText,
      priority: 100,
      order: 0,
    },
  ];
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
    .filter((value) => !config.footer.hidden.includes(value.id))
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
      const contributions: CosmicFooterContribution[] = [
        ...builtinContributions(pi, ctx, footerData, options.totals(), contextUsage()),
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
      const details = text.filter((entry) => entry.region === "details");
      let lines: string[] = [];
      if (width < 48) {
        const essentials = [...identity.filter((entry) => entry.id === "model"), ...metrics];
        if (essentials.length > 0) lines = [renderContributionLine(essentials, width, theme, true)];
      } else {
        if (identity.length) lines.push(renderContributionLine(identity, width, theme, compact));
        if (metrics.length) lines.push(renderContributionLine(metrics, width, theme, compact));
        if (!compact) {
          for (const detail of details)
            lines.push(renderContributionLine([detail], width, theme, false));
        } else if (details.length && width >= 64) {
          lines.push(renderContributionLine(details, width, theme, true));
        }
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
