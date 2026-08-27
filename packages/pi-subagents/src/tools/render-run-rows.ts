import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import type { SubagentRunCard } from "./details.ts";
import { formatCost, formatDuration, formatTokenCount, formatUsage } from "../ui/metrics.ts";
import { projectRunCardTree, runCardTreeBranch } from "./run-card-tree.ts";

const MAX_SESSION_DISPLAY_AGE = 7 * 24 * 60 * 60 * 1_000;

const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

const displayAge = (later: number, earlier: number | undefined): string => {
  if (earlier === undefined) return "";
  const age = later - earlier;
  return age >= 0 && age <= MAX_SESSION_DISPLAY_AGE ? formatDuration(age) : "";
};

export const runTiming = (run: {
  readonly endedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly startedAt?: number | undefined;
}): string => {
  const now = synchronousNow();
  const elapsed = displayAge(run.endedAt ?? now, run.startedAt);
  const activeAge = run.endedAt === undefined ? displayAge(now, run.lastActivityAt) : "";
  const active = activeAge ? `active ${activeAge} ago` : "";
  return [elapsed, active].filter(Boolean).join(" · ");
};

export const aggregateRunUsage = (runs: ReadonlyArray<SubagentRunCard>): string => {
  const tokens = runs.reduce((total, run) => total + (run.usage?.totalTokens ?? 0), 0);
  const knownCosts = runs.flatMap((run) => (run.usage?.cost === undefined ? [] : [run.usage.cost]));
  const cost = knownCosts.reduce((total, value) => total + value, 0);
  const costKnown = knownCosts.length > 0;
  // A subtotal over runs with unknown costs is explicitly marked as a lower bound.
  const partial = costKnown && knownCosts.length < runs.length;
  if (tokens <= 0 && (!costKnown || cost === 0)) return "";
  const costPart = costKnown ? ` · ${partial ? "≥ " : ""}${formatCost(cost)}` : "";
  return `${formatTokenCount(tokens)} tokens${costPart}`;
};

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;

const runRoute = (run: SubagentRunCard, width: number): string => {
  const hostRoute = `${run.host ?? "local"}/${run.runtime ?? "pi"} · `;
  const suffix = `:${run.effort}${run.fastMode ? " ⚡" : ""}`;
  const profile = run.profile ? `[${sanitizeTerminalLine(run.profile)}] ` : "";
  const fixedWidth = visibleWidth(profile) + visibleWidth(hostRoute) + visibleWidth(suffix);
  const modelWidth = Math.max(1, width - fixedWidth);
  return truncateToWidth(
    `${profile}${hostRoute}${truncateToWidth(sanitizeTerminalLine(run.model), modelWidth)}${suffix}`,
    width,
  );
};

const runUsage = (run: SubagentRunCard): string => formatUsage(run.usage, "tok");

export interface ResponsiveRunRowOptions {
  readonly frame?: number;
  readonly status?: (run: SubagentRunCard) => string;
  readonly fullId?: boolean;
  readonly hierarchy?:
    | {
        readonly awaitedRunIds?: ReadonlySet<string> | undefined;
      }
    | undefined;
}

export const renderResponsiveRunRows = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  options: ResponsiveRunRowOptions = {},
): string[] => {
  const safeWidth = Math.max(1, width);
  const treeRows = options.hierarchy ? projectRunCardTree(runs) : undefined;
  const displayRuns = treeRows?.map((row) => row.run) ?? runs;
  const identities = displayRuns.map((run, index) => {
    const glyph =
      options.frame === undefined
        ? runStateGlyph(run.state)
        : animatedRunStateGlyph(run.state, options.frame);
    const id = options.fullId ? run.id : shortRunId(run.id);
    const row = treeRows?.[index];
    const branch = row ? runCardTreeBranch(row) : "";
    const awaited = options.hierarchy?.awaitedRunIds?.has(run.id) ? "◎ " : "";
    return `${branch}${awaited}${glyph} ${sanitizeTerminalLine(run.name)} · ${sanitizeTerminalLine(id)}`;
  });
  const intents = displayRuns.map((run) =>
    sanitizeTerminalLine(run.writeIntent ?? "intent unknown"),
  );
  const states = displayRuns.map((run) =>
    sanitizeTerminalLine(
      options.status?.(run) ??
        [runStateLabel(run.state), run.currentTool, runTiming(run)].filter(Boolean).join(" · "),
    ),
  );
  const usages = displayRuns.map(runUsage);
  const intentWidth = intents.reduce((max, intent) => Math.max(max, visibleWidth(intent)), 0);
  const minimumIdentityWidth = options.hierarchy ? 24 : 16;
  const identityWidth = Math.min(
    Math.max(minimumIdentityWidth, ...identities.map((identity) => visibleWidth(identity))),
    Math.max(minimumIdentityWidth, Math.floor(safeWidth * (options.hierarchy ? 0.4 : 0.28))),
  );
  const stateWidth = Math.min(
    Math.max(14, ...states.map((state) => visibleWidth(state))),
    Math.max(14, Math.floor(safeWidth * 0.28)),
  );
  const hasUsage = usages.some(Boolean);
  const usageWidth = hasUsage
    ? Math.min(
        Math.max(...usages.map((usage) => visibleWidth(usage))),
        Math.max(8, Math.floor(safeWidth * 0.18)),
      )
    : 0;
  const routeWidth =
    safeWidth - identityWidth - intentWidth - stateWidth - usageWidth - (hasUsage ? 12 : 9);
  if (safeWidth >= 88 && routeWidth >= 12)
    return displayRuns.map((run, index) => {
      const color = runStateColor(run.state);
      const identity = theme.fg(color, truncateToWidth(identities[index] ?? "", identityWidth));
      const route = theme.fg("toolOutput", runRoute(run, routeWidth));
      const intent = theme.fg(
        run.writeIntent === "writer" ? "warning" : "muted",
        intents[index] ?? "",
      );
      const usage = theme.fg("muted", truncateToWidth(usages[index] ?? "", usageWidth));
      const state = theme.fg(color, truncateToWidth(states[index] ?? "", stateWidth));
      const usageColumn = hasUsage ? ` · ${padVisible(usage, usageWidth)}` : "";
      return `${padVisible(identity, identityWidth)} · ${padVisible(route, routeWidth)} · ${padVisible(intent, intentWidth)}${usageColumn} · ${padVisible(state, stateWidth)}`;
    });
  return displayRuns.flatMap((run, index) => {
    const color = runStateColor(run.state);
    const identity = theme.fg(color, identities[index] ?? "");
    const intentText = intents[index] ?? "";
    const treeRow = treeRows?.[index];
    const treeIndent = treeRow
      ? " ".repeat(
          visibleWidth(runCardTreeBranch(treeRow)) +
            (options.hierarchy?.awaitedRunIds?.has(run.id) ? 2 : 0) +
            2,
        )
      : "";
    const compactRouteWidth = Math.max(
      1,
      safeWidth - visibleWidth(treeIndent) - visibleWidth(intentText) - 3,
    );
    const route = theme.fg("toolOutput", runRoute(run, compactRouteWidth));
    const metadata = `${treeIndent}${route} · ${theme.fg(
      run.writeIntent === "writer" ? "warning" : "muted",
      intentText,
    )}`;
    const status = `${treeIndent}${[states[index] ?? "", usages[index] ?? ""]
      .filter(Boolean)
      .join(" · ")}`;
    return [
      truncateToWidth(identity, safeWidth),
      truncateToWidth(metadata, safeWidth),
      truncateToWidth(theme.fg(color, status), safeWidth),
    ];
  });
};
