import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { abbreviateHomePath, formatTokens } from "pi-cosmic-core";
import type {
  CosmicFooterStatusContribution,
  CosmicFooterTextContribution,
} from "../protocol/protocol.ts";
import { formatGitStatus, type FooterGitStatus } from "./git.ts";
import type { FooterHostProjection } from "../boundary/host-footer-projection.ts";

export interface FooterTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

/** Generic defaults for host status entries with no declared placement. */
const DEFAULT_STATUS_REGION = "details" as const;
const DEFAULT_STATUS_PRIORITY = 20;
const DEFAULT_STATUS_ORDER = 1020;

export type FooterStatusPlacements = ReadonlyMap<string, CosmicFooterStatusContribution>;

export function builtinContributions(
  host: FooterHostProjection,
  totals: FooterTotals,
  gitStatus: FooterGitStatus | undefined,
  pullRequestNumber: number | undefined,
  homeDirectory: string | undefined,
  statusPlacements: FooterStatusPlacements,
): CosmicFooterTextContribution[] {
  const { model, branch, sessionName, subscription } = host;
  const location = abbreviateHomePath(host.cwd, homeDirectory);

  let modelText = model?.id ?? "no-model";
  const thinking = host.thinking;
  if (host.providerCount > 1 && model) modelText = `${model.provider} / ${modelText}`;

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
      // The component renders context usage; this marker controls visibility and decorations.
      text: "",
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
  if (branch && pullRequestNumber)
    result.push({
      kind: "text",
      id: "pullRequest",
      region: "identity",
      text: `PR #${pullRequestNumber}`,
      priority: 85,
      order: 250,
    });
  if (gitStatus) {
    const dirty =
      gitStatus.staged + gitStatus.modified + gitStatus.untracked + gitStatus.conflicts > 0;
    const gitText = formatGitStatus(gitStatus);
    if (gitText)
      result.push({
        kind: "text",
        id: "git",
        region: "identity",
        text: gitText,
        tone: gitStatus.conflicts ? "error" : dirty ? "warning" : "success",
        align: "right",
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
        align: "right",
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
  for (const status of host.extensionStatuses) {
    const placement = statusPlacements.get(status.id);
    const contribution: CosmicFooterTextContribution = {
      kind: "text",
      id: `extension.${status.id}`,
      region: placement?.region ?? DEFAULT_STATUS_REGION,
      text: status.text,
      priority: placement?.priority ?? DEFAULT_STATUS_PRIORITY,
      order: placement?.order ?? DEFAULT_STATUS_ORDER,
    };
    if (placement?.align) contribution.align = placement.align;
    result.push(contribution);
  }
  return result;
}

/**
 * Folds decorator entries (`decorates`) into their targets by prefixing the
 * decorator's text; decorators without a matching target render standalone.
 */
export function applyTextDecorations(
  entries: readonly CosmicFooterTextContribution[],
): CosmicFooterTextContribution[] {
  const prefixes = new Map<string, string>();
  const consumed = new Set<CosmicFooterTextContribution>();
  for (const entry of entries) {
    const target = entry.decorates;
    if (target === undefined) continue;
    if (!entries.some((candidate) => candidate !== entry && candidate.id === target)) continue;
    consumed.add(entry);
    prefixes.set(target, (prefixes.get(target) ?? "") + entry.text);
  }
  if (prefixes.size === 0) return [...entries];
  return entries
    .filter((entry) => !consumed.has(entry))
    .map((entry) => {
      const prefix = prefixes.get(entry.id);
      if (prefix === undefined) return entry;
      return entry.compactText
        ? {
            ...entry,
            text: `${prefix}${entry.text}`,
            compactText: `${prefix}${entry.compactText}`,
          }
        : { ...entry, text: `${prefix}${entry.text}` };
    });
}

export function orderedContributions(
  values: CosmicFooterTextContribution[],
  config: ResolvedCosmicUiConfig,
): CosmicFooterTextContribution[] {
  const order = new Map(config.footer.order.map((id, index) => [id, index]));
  return values
    .filter(
      (value) =>
        !config.footer.hidden.includes(value.id) &&
        !(value.id.startsWith("metrics.") && config.footer.hidden.includes("metrics")) &&
        !(value.id.startsWith("git.") && config.footer.hidden.includes("git")) &&
        !(value.id.startsWith("extension.") && config.footer.hidden.includes("extensions")),
    )
    .sort((a, b) => (order.get(a.id) ?? a.order ?? 500) - (order.get(b.id) ?? b.order ?? 500));
}
