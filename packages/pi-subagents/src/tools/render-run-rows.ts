import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import type { SubagentRunCard } from "./details.ts";
import { formatCost, formatDuration, formatTokenCount, formatUsage } from "../ui/metrics.ts";
import {
  projectRunCardTree,
  runCardTreeBranch,
  runCardTreeMetadataBranch,
  type RunTreeRow,
} from "./run-card-tree.ts";

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

const runProfile = (run: SubagentRunCard): string =>
  sanitizeTerminalLine(run.profile ?? "generalist");

const runRoute = (run: SubagentRunCard): string =>
  `${runProfile(run)} → ${run.host ?? "local"}/${run.runtime ?? "pi"} · ${sanitizeTerminalLine(run.model)}:${run.effort}${run.fastMode ? " ⚡" : ""}`;

const themedRunRoute = (run: SubagentRunCard, theme: Theme): string =>
  `${theme.fg("muted", runProfile(run))} ${theme.fg("dim", "→")} ${theme.fg(
    "toolOutput",
    `${run.host ?? "local"}/${run.runtime ?? "pi"} · ${sanitizeTerminalLine(run.model)}:${run.effort}${run.fastMode ? " ⚡" : ""}`,
  )}`;

interface MetadataRail {
  readonly first: string;
  readonly continuation: string;
}

const responsiveMetadataRail = (
  row: RunTreeRow<SubagentRunCard> | undefined,
  width: number,
): MetadataRail => {
  const rail = row ? runCardTreeMetadataBranch(row) : { first: "  ╰─ ", continuation: "     " };
  return visibleWidth(rail.first) < width ? rail : { first: "╰─ ", continuation: "   " };
};

const renderRouteRail = (
  run: SubagentRunCard,
  row: RunTreeRow<SubagentRunCard> | undefined,
  width: number,
  theme: Theme,
): string[] => {
  const rail = responsiveMetadataRail(row, width);
  const available = Math.max(1, width - visibleWidth(rail.first));
  const routeLines = wrapTextWithAnsi(themedRunRoute(run, theme), available);
  return routeLines.map((line, index) =>
    truncateToWidth(
      `${theme.fg("dim", index === 0 ? rail.first : rail.continuation)}${line}`,
      width,
    ),
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
  const routes = displayRuns.map(runRoute);
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
  if (
    safeWidth >= 88 &&
    routeWidth >= 12 &&
    routes.every((route) => visibleWidth(route) <= routeWidth)
  )
    return displayRuns.map((run, index) => {
      const color = runStateColor(run.state);
      const identity = theme.fg(color, truncateToWidth(identities[index] ?? "", identityWidth));
      const route = themedRunRoute(run, theme);
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
    const identity = identities[index] ?? "";
    const compactStatus = [
      runStateLabel(run.state),
      run.currentTool ? sanitizeTerminalLine(run.currentTool) : undefined,
      run.writeIntent === "writer" ? "writer" : undefined,
      usages[index],
    ]
      .filter(Boolean)
      .join(" · ");
    const compactMinimumIdentityWidth = Math.min(24, Math.max(8, Math.floor(safeWidth * 0.45)));
    const maximumStatusWidth = safeWidth - compactMinimumIdentityWidth - 3;
    const identityLine = (() => {
      if (maximumStatusWidth < 7) return truncateToWidth(theme.fg(color, identity), safeWidth);
      const compactStatusWidth = Math.min(
        visibleWidth(compactStatus),
        Math.max(7, Math.floor(safeWidth * 0.36)),
        maximumStatusWidth,
      );
      const compactIdentityWidth = safeWidth - compactStatusWidth - 3;
      return `${truncateToWidth(
        theme.fg(color, identity),
        compactIdentityWidth,
      )} · ${truncateToWidth(theme.fg(color, compactStatus), compactStatusWidth)}`;
    })();
    return [identityLine, ...renderRouteRail(run, treeRows?.[index], safeWidth, theme)];
  });
};
