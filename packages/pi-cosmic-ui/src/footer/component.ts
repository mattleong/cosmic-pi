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
} from "../protocol/protocol.ts";
import type { HostCallbackBoundaryContract } from "../boundary/host-callback.ts";
import {
  applyTextDecorations,
  builtinContributions,
  orderedContributions,
  type FooterStatusPlacements,
  type FooterTotals,
} from "./builtin-contributions.ts";
import { type FooterGitStatus } from "./git.ts";
import { combineSurface, renderContributionLine, renderModelContextLine } from "./layout.ts";
import { renderMetricsLines } from "./metrics.ts";
import { renderProviderUsageLines } from "./provider-usage.ts";
import {
  hostQuery,
  materializeContextUsage,
  materializeFooterHostProjection,
  materializeModel,
  type FooterContextUsage,
  type FooterModel,
} from "../boundary/host-footer-projection.ts";
import { footerSurfaces, type FooterRegistrySnapshot } from "./registry.ts";

export type { FooterTotals } from "./builtin-contributions.ts";

export interface FooterContributionView {
  readonly snapshot: () => FooterRegistrySnapshot;
  readonly invalidate: () => void;
}

export function createFooterComponent(options: {
  pi: ExtensionAPI;
  ctx(): ExtensionContext;
  homeDirectory(): string | undefined;
  footerData: ReadonlyFooterDataProvider;
  theme: CosmicFooterTheme;
  registry: FooterContributionView;
  callbacks: HostCallbackBoundaryContract;
  config(): ResolvedCosmicUiConfig;
  totals(): FooterTotals;
  gitStatus(): FooterGitStatus | undefined;
  pullRequestNumber(): number | undefined;
}) {
  const { pi, footerData, theme, registry } = options;
  let contextUsageCached = false;
  let cachedContextUsage: FooterContextUsage;
  let cachedLeafId: string | null | undefined;
  let cachedModel: FooterModel | undefined;

  function invalidateContextUsage(): void {
    contextUsageCached = false;
    cachedContextUsage = undefined;
    cachedLeafId = undefined;
    cachedModel = undefined;
  }

  function contextUsage(
    ctx: ExtensionContext | undefined,
    model: FooterModel | undefined,
  ): FooterContextUsage {
    if (!ctx) return undefined;
    const leafId = hostQuery<string | null | undefined>(
      options.callbacks,
      () => ctx.sessionManager.getLeafId(),
      undefined,
    );
    if (!contextUsageCached || leafId !== cachedLeafId || model !== cachedModel) {
      cachedContextUsage = materializeContextUsage(ctx, options.callbacks);
      contextUsageCached = true;
      cachedLeafId = leafId;
      cachedModel = model;
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
      return options.callbacks.invoke(
        "footer-render",
        () => {
          const config = options.config();
          const ctx = hostQuery<ExtensionContext | undefined>(
            options.callbacks,
            options.ctx,
            undefined,
          );
          const model = ctx ? materializeModel(ctx, options.callbacks) : undefined;
          const currentContextUsage = contextUsage(ctx, model?.source);
          const host = materializeFooterHostProjection({
            pi,
            ctx,
            footerData,
            callbacks: options.callbacks,
            model,
          });
          const registrySnapshot = registry.snapshot();
          const statusPlacements: FooterStatusPlacements = new Map(
            registrySnapshot.contributions.flatMap((entry) =>
              entry.kind === "status" ? [[entry.id, entry] as const] : [],
            ),
          );
          const contributions: CosmicFooterContribution[] = [
            ...builtinContributions(
              host,
              options.totals(),
              options.gitStatus(),
              options.pullRequestNumber(),
              options.homeDirectory(),
              statusPlacements,
            ),
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
          const labeledDetails = details.filter((entry) => entry.label !== undefined);
          const extensionDetails = details.filter((entry) => entry.id.startsWith("extension."));
          const otherDetails = details.filter(
            (entry) => entry.label === undefined && !entry.id.startsWith("extension."),
          );
          let lines: string[] = [];
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
          for (const usage of labeledDetails) {
            const label = usage.label;
            if (!label) continue;
            lines.push(
              ...renderProviderUsageLines(
                label,
                compact && usage.compactText !== undefined ? usage.compactText : usage.text,
                width,
                theme,
                compact,
              ),
            );
          }
          for (const detail of extensionDetails)
            lines.push(renderContributionLine([detail], width, theme, compact));
          if (!compact) {
            for (const detail of otherDetails)
              lines.push(renderContributionLine([detail], width, theme, false));
          } else if (otherDetails.length && width >= 64) {
            lines.push(renderContributionLine(otherDetails, width, theme, true));
          }
          const surface = footerSurfaces(registrySnapshot).find(
            (entry) => !config.footer.hidden.includes(entry.id),
          );
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
            lines = options.callbacks.invoke(
              "surface-render",
              () =>
                combineSurface(
                  surface.render({ width: surfaceWidth, placement, theme }),
                  lines,
                  width,
                  placement,
                  surfaceWidth,
                ),
              lines,
            );
          }
          return surface ? lines : lines.map((line) => truncateToWidth(line, width, ""));
        },
        [],
      );
    },
  };
}
