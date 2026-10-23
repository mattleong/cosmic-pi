import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { abbreviateHomePath, formatTokens, formatCost } from "pi-cosmic-core";
import type {
  CosmicFooterColor,
  CosmicFooterStatusContribution,
  CosmicFooterTextContribution,
} from "../protocol/protocol.ts";
import { DEFAULT_CONTRIBUTION_ORDER } from "./contributions.ts";
import { formatGitStatus, type FooterGitStatus } from "./git.ts";
import type { FooterHostProjection } from "../boundary/host-footer-projection.ts";
import type { FooterTotals } from "../boundary/host-usage.ts";

function basename(path: string): string {
  const normalized = Fn.pipe(path, Str.replace(/\/$/, ""));
  const start = Option.getOrElse(Fn.pipe(normalized, Str.lastIndexOf("/")), () => -1) + 1;
  return Fn.pipe(normalized, Str.slice(start)) || normalized;
}

const DEFAULT_STATUS_REGION = "details" as const;
const DEFAULT_STATUS_PRIORITY = 20;
const DEFAULT_STATUS_ORDER = 1020;

const THINKING_COLORS: ReadonlyMap<string, CosmicFooterColor> = new Map([
  ["off", "thinkingOff"],
  ["minimal", "thinkingMinimal"],
  ["low", "thinkingLow"],
  ["medium", "thinkingMedium"],
  ["high", "thinkingHigh"],
  ["xhigh", "thinkingXhigh"],
  ["max", "thinkingMax"],
]);

export type FooterStatusPlacements = ReadonlyMap<string, CosmicFooterStatusContribution>;

export interface FooterRepositoryProjection {
  readonly totals: FooterTotals;
  readonly gitStatus: FooterGitStatus | undefined;
  readonly pullRequestNumber: number | undefined;
  readonly pullRequestUrl: string | undefined;
  readonly homeDirectory: string | undefined;
}

const identityContributions = (
  host: FooterHostProjection,
  location: string,
): CosmicFooterTextContribution[] => {
  const { model, thinking } = host;
  const modelText =
    host.providerCount > 1 && model ? `${model.provider} / ${model.id}` : (model?.id ?? "no-model");
  return [
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
            tone: "normal" as const,
            color: THINKING_COLORS.get(thinking) ?? "thinkingText",
            priority: 95,
            order: 100,
          },
        ]
      : []),
    {
      kind: "text",
      id: "location",
      region: "identity",
      text: `⌂ ${location}`,
      compactText: `⌂ ${basename(location)}`,
      tone: "normal",
      color: "accent",
      priority: 100,
      order: 200,
    },
    {
      kind: "text",
      id: "context",
      region: "metrics",
      text: "",
      priority: 100,
      order: 0,
    },
  ];
};

const branchContributions = (
  branch: string | null,
  pullRequestNumber: number | undefined,
): CosmicFooterTextContribution[] => {
  if (!branch) return [];
  const branchEntry: CosmicFooterTextContribution = {
    kind: "text",
    id: "branch",
    region: "identity",
    text: `⎇ ${branch}`,
    compactText: `⎇ ${branch}`,
    tone: "normal",
    color: "syntaxType",
    priority: 90,
    order: 200,
  };
  if (!pullRequestNumber) return [branchEntry];
  return [
    branchEntry,
    {
      kind: "text",
      id: "pullRequest",
      region: "identity",
      text: `PR #${pullRequestNumber}`,
      priority: 85,
      order: 250,
    },
  ];
};

const gitTone = (gitStatus: FooterGitStatus): CosmicFooterTextContribution["tone"] => {
  if (gitStatus.conflicts) return "error";
  const dirty =
    gitStatus.staged + gitStatus.modified + gitStatus.untracked + gitStatus.conflicts > 0;
  return dirty ? "warning" : "success";
};

const GIT_LINE_STATS = [
  ["linesAdded", "+"],
  ["linesRemoved", "-"],
  ["linesChanged", "~"],
] as const satisfies ReadonlyArray<readonly [keyof FooterGitStatus, string]>;

const gitContributions = (
  gitStatus: FooterGitStatus | undefined,
): CosmicFooterTextContribution[] => {
  if (!gitStatus) return [];
  const result: CosmicFooterTextContribution[] = [];
  const gitText = formatGitStatus(gitStatus);
  if (gitText)
    result.push({
      kind: "text",
      id: "git",
      region: "identity",
      text: gitText,
      tone: gitTone(gitStatus),
      align: "right",
      priority: 80,
      order: 300,
    });
  const lineStats = Arr.flatMap(GIT_LINE_STATS, ([key, sign]) =>
    gitStatus[key] ? [`${sign}${gitStatus[key]}L`] : [],
  );
  if (lineStats.length)
    result.push({
      kind: "text",
      id: "git.lines",
      region: "identity",
      text: Arr.join(lineStats, " "),
      align: "right",
      priority: 75,
      order: 310,
    });
  return result;
};

const sessionContributions = (sessionName: string | undefined): CosmicFooterTextContribution[] =>
  sessionName
    ? [
        {
          kind: "text",
          id: "session",
          region: "metrics",
          text: sessionName,
          tone: "accent",
          priority: 80,
          order: 100,
        },
      ]
    : [];

const metric = (
  id: string,
  text: string,
  order: number,
  align?: "right",
): CosmicFooterTextContribution => ({
  kind: "text",
  id,
  region: "metrics",
  text,
  priority: 90,
  order,
  ...(align && { align }),
});

const TOKEN_METRICS = [
  ["input", "↑", 200],
  ["output", "↓", 210],
  ["cacheRead", "r", 220],
  ["cacheWrite", "w", 230],
] as const satisfies ReadonlyArray<readonly [keyof FooterTotals, string, number]>;

const metricContributions = (
  totals: FooterTotals,
  subscription: boolean,
): CosmicFooterTextContribution[] => [
  ...Arr.flatMap(TOKEN_METRICS, ([key, prefix, order]) =>
    totals[key] ? [metric(`metrics.${key}`, `${prefix}${formatTokens(totals[key])}`, order)] : [],
  ),
  ...(totals.cost || subscription
    ? [
        metric(
          "metrics.cost",
          `${formatCost(totals.cost)}${subscription ? " (sub)" : ""}`,
          240,
          "right",
        ),
      ]
    : []),
];

const extensionStatusContribution = (
  status: FooterHostProjection["extensionStatuses"][number],
  statusPlacements: FooterStatusPlacements,
): CosmicFooterTextContribution => {
  const placement = statusPlacements.get(status.id);
  return {
    kind: "text",
    id: `extension.${status.id}`,
    region: placement?.region ?? DEFAULT_STATUS_REGION,
    text: status.text,
    priority: placement?.priority ?? DEFAULT_STATUS_PRIORITY,
    order: placement?.order ?? DEFAULT_STATUS_ORDER,
    ...(placement?.align && { align: placement.align }),
  };
};

export function builtinContributions(
  host: FooterHostProjection,
  { totals, gitStatus, pullRequestNumber, homeDirectory }: FooterRepositoryProjection,
  statusPlacements: FooterStatusPlacements,
): CosmicFooterTextContribution[] {
  return [
    ...identityContributions(host, abbreviateHomePath(host.cwd, homeDirectory)),
    ...branchContributions(host.branch, pullRequestNumber),
    ...gitContributions(gitStatus),
    ...sessionContributions(host.sessionName),
    ...metricContributions(totals, host.subscription),
    ...Arr.map(host.extensionStatuses, (status) =>
      extensionStatusContribution(status, statusPlacements),
    ),
  ];
}

export function applyTextDecorations(
  entries: readonly CosmicFooterTextContribution[],
): CosmicFooterTextContribution[] {
  const prefixes = new Map<string, string>();
  const consumed = new Set<CosmicFooterTextContribution>();
  for (const entry of entries) {
    const target = entry.decorates;
    if (target === undefined) continue;
    if (!Arr.some(entries, (candidate) => candidate !== entry && candidate.id === target)) continue;
    consumed.add(entry);
    prefixes.set(target, (prefixes.get(target) ?? "") + entry.text);
  }
  if (prefixes.size === 0) return [...entries];
  return Arr.flatMap(entries, (entry) => {
    if (consumed.has(entry)) return [];
    const prefix = prefixes.get(entry.id);
    if (prefix === undefined) return [entry];
    return [
      Object.assign(
        {},
        entry,
        { text: `${prefix}${entry.text}` },
        entry.compactText === undefined ? {} : { compactText: `${prefix}${entry.compactText}` },
      ),
    ];
  });
}

export function orderedContributions(
  values: CosmicFooterTextContribution[],
  config: ResolvedCosmicUiConfig,
): CosmicFooterTextContribution[] {
  const order = new Map(Arr.map(config.footer.order, (id, index) => [id, index] as const));
  const hidden = config.footer.hidden;
  return Arr.sort(
    Arr.flatMap(values, (value) => {
      if (
        hidden.includes(value.id) ||
        (Fn.pipe(value.id, Str.startsWith("metrics.")) && hidden.includes("metrics")) ||
        (Fn.pipe(value.id, Str.startsWith("git.")) && hidden.includes("git")) ||
        (Fn.pipe(value.id, Str.startsWith("extension.")) && hidden.includes("extensions"))
      ) {
        return [];
      }
      const configuredOrder = order.get(value.id);
      return [
        configuredOrder === undefined
          ? value
          : Object.assign({}, value, { order: configuredOrder }),
      ];
    }),
    Order.mapInput(
      Order.Number,
      (entry: CosmicFooterTextContribution) => entry.order ?? DEFAULT_CONTRIBUTION_ORDER,
    ),
  );
}
