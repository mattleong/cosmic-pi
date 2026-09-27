import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  formatRunRouteLine,
  formatSessionActivity,
  formatSessionAge,
  shortRunId,
} from "../ui/run-presentation.ts";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { clipToWidth } from "pi-cosmic-ui/manager";

export const runTiming = (run: {
  readonly endedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly startedAt?: number | undefined;
}): string => {
  const now = synchronousNow();
  const elapsed = formatSessionAge(run.endedAt ?? now, run.startedAt);
  const activeAge = run.endedAt === undefined ? formatSessionActivity(now, run.lastActivityAt) : "";
  const active = activeAge ? `active ${activeAge}` : "";
  return [elapsed, active].filter(Boolean).join(" · ");
};

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;

const renderRouteRail = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const prefix = width > 5 ? "     " : "   ";
  const available = Math.max(1, width - visibleWidth(prefix));
  const routeLines = wrapTextWithAnsi(formatRunRouteLine(run, theme), available);
  return routeLines.map((line) => clipToWidth(`${prefix}${line}`, width));
};

const runUsage = (run: SubagentRunCard): string => aggregateUsage([run], "compact");

interface RunIdentity {
  readonly plain: string;
  readonly themed: string;
}

const renderHierarchyRow = (
  run: SubagentRunCard,
  identity: RunIdentity,
  usage: string,
  width: number,
  theme: Theme,
): string => {
  const themedIdentity = identity.themed;
  const timing = runTiming(run);
  const metadata = [
    formatRunRouteLine(run, theme),
    run.writeIntent === "writer" ? theme.fg("warning", "writer") : undefined,
    usage ? theme.fg("muted", usage) : undefined,
    run.currentTool ? theme.fg("accent", sanitizeTerminalLine(run.currentTool)) : undefined,
    timing ? theme.fg("muted", timing) : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(theme.fg("dim", " · "));
  const combined = `${themedIdentity}${theme.fg("dim", " · ")}${metadata}`;
  if (visibleWidth(combined) <= width) return combined;
  if (width < 12) return clipToWidth(themedIdentity, width);
  const identityWidth = Math.min(
    visibleWidth(identity.plain),
    Math.max(8, Math.floor(width * 0.42)),
  );
  const metadataWidth = width - identityWidth - 3;
  if (metadataWidth < 8) return clipToWidth(themedIdentity, width);
  return `${clipToWidth(themedIdentity, identityWidth)}${theme.fg(
    "dim",
    " · ",
  )}${clipToWidth(metadata, metadataWidth)}`;
};

export interface RunHierarchy {
  readonly awaitedRunIds?: ReadonlySet<string> | undefined;
  readonly contextOmitted?: boolean | undefined;
}

export interface ResponsiveRunRowOptions {
  readonly frame?: number;
  /** Expanded rows show every run ID; collapsed rows only tell same-named runs apart. */
  readonly fullId?: boolean;
  readonly hierarchy?: RunHierarchy | undefined;
}

/** The ID a row shows: all of it expanded, a short form for a shared name, else none. */
const rowRunId = (
  run: SubagentRunCard,
  fullId: boolean,
  sharedNames: ReadonlySet<string>,
): string | undefined =>
  fullId ? run.id : sharedNames.has(run.name) ? shortRunId(run.id) : undefined;

const sharedRunNames = (runs: ReadonlyArray<SubagentRunCard>): ReadonlySet<string> => {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const run of runs) (seen.has(run.name) ? shared : seen).add(run.name);
  return shared;
};

export const renderResponsiveRunRows = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  options: ResponsiveRunRowOptions = {},
): string[] => {
  const safeWidth = Math.max(1, width);
  const treeRows = options.hierarchy ? projectRunCardTree(runs) : undefined;
  const displayRuns = treeRows?.map((row) => row.run) ?? runs;
  const sharedNames = sharedRunNames(displayRuns);
  const identities = displayRuns.map((run, index): RunIdentity => {
    const glyph =
      options.frame === undefined
        ? runStateGlyph(run.state)
        : animatedRunStateGlyph(run.state, options.frame);
    const shownId = rowRunId(run, options.fullId === true, sharedNames);
    const row = treeRows?.[index];
    const branch = row ? runTreeBranch(row) : "";
    const awaited = options.hierarchy?.awaitedRunIds?.has(run.id) ? "◎ " : "";
    const identity = `${branch}${awaited}${glyph} ${sanitizeTerminalLine(run.name)}`;
    const themedIdentity = theme.fg(runStateColor(run.state), identity);
    if (shownId === undefined) return { plain: identity, themed: themedIdentity };
    const id = sanitizeTerminalLine(shownId);
    return {
      plain: `${identity} · ${id}`,
      themed: `${themedIdentity}${theme.fg("dim", " · ")}${theme.fg("muted", id)}`,
    };
  });
  const intents = displayRuns.map((run) => sanitizeTerminalLine(run.writeIntent));
  const states = displayRuns.map((run) =>
    sanitizeTerminalLine(
      [runStateLabel(run.state), run.currentTool, runTiming(run)].filter(Boolean).join(" · "),
    ),
  );
  const usages = displayRuns.map(runUsage);
  if (treeRows)
    return displayRuns.map((run, index) =>
      renderHierarchyRow(
        run,
        identities[index] ?? { plain: "", themed: "" },
        usages[index] ?? "",
        safeWidth,
        theme,
      ),
    );
  const routes = displayRuns.map((run) => formatRunRouteLine(run));
  const intentWidth = intents.reduce((max, intent) => Math.max(max, visibleWidth(intent)), 0);
  const identityWidth = Math.min(
    Math.max(16, ...identities.map((identity) => visibleWidth(identity.plain))),
    Math.max(16, Math.floor(safeWidth * 0.28)),
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
      const identity = clipToWidth(identities[index]?.themed ?? "", identityWidth);
      const route = formatRunRouteLine(run, theme);
      const intent = theme.fg(
        run.writeIntent === "writer" ? "warning" : "muted",
        intents[index] ?? "",
      );
      const usage = theme.fg("muted", clipToWidth(usages[index] ?? "", usageWidth));
      const state = theme.fg(color, clipToWidth(states[index] ?? "", stateWidth));
      const usageColumn = hasUsage ? ` · ${padVisible(usage, usageWidth)}` : "";
      return `${padVisible(identity, identityWidth)} · ${padVisible(route, routeWidth)} · ${padVisible(intent, intentWidth)}${usageColumn} · ${padVisible(state, stateWidth)}`;
    });
  return displayRuns.flatMap((run, index) => {
    const color = runStateColor(run.state);
    const identity = identities[index] ?? { plain: "", themed: "" };
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
      if (maximumStatusWidth < 7) return clipToWidth(identity.themed, safeWidth);
      const compactStatusWidth = Math.min(
        visibleWidth(compactStatus),
        Math.max(7, Math.floor(safeWidth * 0.36)),
        maximumStatusWidth,
      );
      const compactIdentityWidth = safeWidth - compactStatusWidth - 3;
      return `${clipToWidth(
        identity.themed,
        compactIdentityWidth,
      )} · ${clipToWidth(theme.fg(color, compactStatus), compactStatusWidth)}`;
    })();
    return [identityLine, ...renderRouteRail(run, safeWidth, theme)];
  });
};
