import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import type {
  CosmicFooterContribution,
  CosmicFooterTextContribution,
  CosmicFooterTheme,
} from "../protocol/protocol.ts";
import {
  applyTextDecorations,
  builtinContributions,
  orderedContributions,
  type FooterRepositoryProjection,
  type FooterStatusPlacements,
} from "./builtin-contributions.ts";
import { renderContributionLine } from "./contributions.ts";
import { renderModelContextLine } from "./layout.ts";
import { renderMetricsLines } from "./metrics.ts";
import { renderProviderUsageLines } from "./provider-usage.ts";
import {
  materializeContextUsage,
  materializeFooterHostProjection,
  materializeModel,
  type FooterContextUsage,
  type FooterModel,
} from "../boundary/host-footer-projection.ts";
import type { FooterRegistry } from "./registry.ts";
import { clipToWidth } from "../manager/chrome.ts";

type LabeledContribution = CosmicFooterTextContribution & { readonly label: string };

export function createFooterComponent(options: {
  pi: ExtensionAPI;
  ctx(): ExtensionContext;
  footerData: ReadonlyFooterDataProvider;
  theme: CosmicFooterTheme;
  registry: Pick<FooterRegistry, "snapshot">;
  config(): ResolvedCosmicUiConfig;
  projection(): FooterRepositoryProjection;
}) {
  const { pi, footerData, theme, registry } = options;
  let cached:
    | {
        readonly leafId: string | null | undefined;
        readonly model: FooterModel | undefined;
        readonly usage: FooterContextUsage;
      }
    | undefined;

  function invalidateContextUsage(): void {
    cached = undefined;
  }

  function contextUsage(
    ctx: ExtensionContext | undefined,
    model: FooterModel | undefined,
  ): FooterContextUsage {
    if (!ctx) return undefined;
    const leafId = invokeHostCallback<string | null | undefined>(
      () => ctx.sessionManager.getLeafId(),
      undefined,
    );
    if (!cached || cached.leafId !== leafId || cached.model !== model)
      cached = { leafId, model, usage: materializeContextUsage(ctx) };
    return cached.usage;
  }

  return {
    invalidate: invalidateContextUsage,
    invalidateContextUsage,
    render(width: number): string[] {
      if (width <= 0) return [];
      return invokeHostCallback(() => {
        const config = options.config();
        const ctx = invokeHostCallback<ExtensionContext | undefined>(options.ctx, undefined);
        const model = ctx ? materializeModel(ctx) : undefined;
        const currentContextUsage = contextUsage(ctx, model?.source);
        const host = materializeFooterHostProjection({ pi, ctx, footerData, model });
        const registrySnapshot = registry.snapshot();
        const statusPlacements: FooterStatusPlacements = new Map(
          registrySnapshot.contributions.flatMap((entry) =>
            entry.kind === "status" ? [[entry.id, entry] as const] : [],
          ),
        );
        const contributions: CosmicFooterContribution[] = [
          ...builtinContributions(host, options.projection(), statusPlacements),
          ...registrySnapshot.contributions,
        ];
        const text = applyTextDecorations(
          orderedContributions(
            contributions.filter(
              (entry): entry is CosmicFooterTextContribution => entry.kind === "text",
            ),
            config,
          ),
        );
        const compact =
          config.footer.density === "compact" || (config.footer.density === "auto" && width < 72);
        const identity = text.filter((entry) => entry.region === "identity");
        const repositoryIdentity = identity.filter(
          (entry) =>
            entry.id === "location" ||
            entry.id === "branch" ||
            entry.id === "pullRequest" ||
            entry.id.startsWith("git"),
        );
        const modelIdentity = identity.filter((entry) => !repositoryIdentity.includes(entry));
        const metrics = text.filter((entry) => entry.region === "metrics");
        const contextVisible = metrics.some((entry) => entry.id === "context");
        const metricEntries = metrics.filter((entry) => entry.id !== "context");
        const details = text.filter((entry) => entry.region === "details");
        // Labeled, unlabeled host-status, and other details partition the region, so a labeled
        // contribution renders once even when its id starts with `extension.`.
        const labeledDetails = details.filter(
          (entry): entry is LabeledContribution => entry.label !== undefined,
        );
        const unlabeled = details.filter((entry) => entry.label === undefined);
        const extensionDetails = unlabeled.filter((entry) => entry.id.startsWith("extension."));
        const otherDetails = unlabeled.filter((entry) => !entry.id.startsWith("extension."));
        const lines: string[] = [];
        if (modelIdentity.length || contextVisible)
          lines.push(
            contextVisible
              ? renderModelContextLine(modelIdentity, currentContextUsage, width, theme, compact)
              : renderContributionLine(modelIdentity, width, theme, compact),
          );
        if (repositoryIdentity.length)
          lines.push(renderContributionLine(repositoryIdentity, width, theme, compact));
        if (metricEntries.length)
          lines.push(...renderMetricsLines(metricEntries, width, theme, compact));
        for (const usage of labeledDetails)
          lines.push(
            ...renderProviderUsageLines(
              usage.label,
              compact && usage.compactText !== undefined ? usage.compactText : usage.text,
              width,
              theme,
              compact,
            ),
          );
        for (const detail of extensionDetails)
          lines.push(renderContributionLine([detail], width, theme, compact));
        if (!compact) {
          for (const detail of otherDetails)
            lines.push(renderContributionLine([detail], width, theme, false));
        } else if (otherDetails.length && width >= 64) {
          lines.push(renderContributionLine(otherDetails, width, theme, true));
        }
        return lines.map((line) => clipToWidth(line, width, ""));
      }, []);
    },
  };
}
