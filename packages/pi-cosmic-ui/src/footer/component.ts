import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
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
  sameContextUsage,
  sameFooterHostProjection,
  type FooterContextUsage,
  type FooterHostProjection,
  type FooterModel,
} from "../boundary/host-footer-projection.ts";
import type { FooterRegistry } from "./registry.ts";
import { clipToWidth } from "../manager/chrome.ts";

type LabeledContribution = CosmicFooterTextContribution & { readonly label: string };

/** Everything a footer render reads except the theme, whose changes reach `invalidate()`. */
interface FooterRenderInputs {
  readonly width: number;
  readonly config: ResolvedCosmicUiConfig;
  readonly projection: FooterRepositoryProjection;
  readonly contributions: readonly CosmicFooterContribution[];
  readonly contextUsage: FooterContextUsage;
  readonly host: FooterHostProjection;
  readonly hyperlinks: boolean;
}

const sameRenderInputs = (left: FooterRenderInputs, right: FooterRenderInputs): boolean =>
  left.width === right.width &&
  left.config === right.config &&
  left.projection === right.projection &&
  left.contributions === right.contributions &&
  left.hyperlinks === right.hyperlinks &&
  sameContextUsage(left.contextUsage, right.contextUsage) &&
  sameFooterHostProjection(left.host, right.host);

const isRepositoryIdentity = (entry: CosmicFooterTextContribution) =>
  entry.id === "location" ||
  entry.id === "branch" ||
  entry.id === "pullRequest" ||
  Fn.pipe(entry.id, Str.startsWith("git"));

function detailLines(
  details: readonly CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
): string[] {
  const labeledDetails = Arr.filter(
    details,
    (entry): entry is LabeledContribution => entry.label !== undefined,
  );
  const unlabeled = Arr.filter(details, (entry) => entry.label === undefined);
  const extensionDetails = Arr.filter(unlabeled, (entry) =>
    Fn.pipe(entry.id, Str.startsWith("extension.")),
  );
  const otherDetails = Arr.filter(
    unlabeled,
    (entry) => !Fn.pipe(entry.id, Str.startsWith("extension.")),
  );
  const lines: string[] = [];
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
  return lines;
}

function footerLines(
  text: readonly CosmicFooterTextContribution[],
  width: number,
  theme: CosmicFooterTheme,
  compact: boolean,
  currentContextUsage: FooterContextUsage,
  pullRequestUrl: string | undefined,
): string[] {
  const identity = Arr.filter(text, (entry) => entry.region === "identity");
  const repositoryIdentity = Arr.filter(identity, isRepositoryIdentity);
  const modelIdentity = Arr.filter(identity, (entry) => !repositoryIdentity.includes(entry));
  const metrics = Arr.filter(text, (entry) => entry.region === "metrics");
  const contextVisible = Arr.some(metrics, (entry) => entry.id === "context");
  const metricEntries = Arr.filter(metrics, (entry) => entry.id !== "context");
  const lines: string[] = [];
  if (modelIdentity.length || contextVisible)
    lines.push(
      contextVisible
        ? renderModelContextLine(modelIdentity, currentContextUsage, width, theme, compact)
        : renderContributionLine(modelIdentity, width, theme, compact),
    );
  if (repositoryIdentity.length)
    lines.push(renderContributionLine(repositoryIdentity, width, theme, compact, pullRequestUrl));
  if (metricEntries.length) lines.push(...renderMetricsLines(metricEntries, width, theme, compact));
  lines.push(
    ...detailLines(
      Arr.filter(text, (entry) => entry.region === "details"),
      width,
      theme,
      compact,
    ),
  );
  return lines;
}

export function createFooterComponent(options: {
  pi: ExtensionAPI;
  ctx: () => ExtensionContext;
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
  // Pi renders the footer on every frame, mostly with unchanged inputs.
  let rendered:
    | { readonly inputs: FooterRenderInputs; readonly lines: readonly string[] }
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
    invalidate(): void {
      cached = undefined;
      rendered = undefined;
    },
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
        const projection = options.projection();
        const inputs: FooterRenderInputs = {
          width,
          config,
          projection,
          contributions: registrySnapshot.contributions,
          contextUsage: currentContextUsage,
          host,
          hyperlinks: getCapabilities().hyperlinks,
        };
        if (rendered && sameRenderInputs(rendered.inputs, inputs)) return [...rendered.lines];
        const statusPlacements: FooterStatusPlacements = new Map(
          Arr.flatMap(registrySnapshot.contributions, (entry) =>
            entry.kind === "status" ? [[entry.id, entry] as const] : [],
          ),
        );
        const contributions: CosmicFooterContribution[] = [
          ...builtinContributions(host, projection, statusPlacements),
          ...registrySnapshot.contributions,
        ];
        const text = applyTextDecorations(
          orderedContributions(
            Arr.filter(contributions, (entry) => entry.kind === "text"),
            config,
          ),
        );
        const compact =
          config.footer.density === "compact" || (config.footer.density === "auto" && width < 72);
        const lines = footerLines(
          text,
          width,
          theme,
          compact,
          currentContextUsage,
          projection.pullRequestUrl,
        );
        // Wrapped metric and usage rows can exceed narrow widths by a wide grapheme.
        const clipped = Arr.map(lines, (line) => clipToWidth(line, width, ""));
        rendered = { inputs, lines: clipped };
        return [...clipped];
      }, []);
    },
  };
}
