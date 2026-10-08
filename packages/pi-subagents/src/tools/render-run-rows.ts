import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  duplicateRunNames,
  formatRunRouteLine,
  formatSessionActivity,
  formatSessionAge,
  shortRunId,
} from "../ui/run-presentation.ts";
import { runStateColor, runStateGlyph, runStateLabel } from "../ui/run-state.ts";
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

/** One run's row parts, each computed once for every layout. */
interface RunRow {
  readonly run: SubagentRunCard;
  readonly identity: { readonly plain: string; readonly themed: string };
  readonly intent: string;
  readonly state: string;
  readonly usage: string;
}

const renderHierarchyRow = (
  { run, identity, usage }: RunRow,
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

interface ResponsiveRunRowOptions {
  readonly frame?: number;
  /** Expanded rows show every run ID; collapsed rows only tell same-named runs apart. */
  readonly fullId?: boolean;
  readonly hierarchy?: RunHierarchy | undefined;
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
  const sharedNames = duplicateRunNames(displayRuns);
  const rows = displayRuns.map((run, index): RunRow => {
    const glyph = runStateGlyph(run.state, options.frame);
    // All of the ID expanded, a short form for a shared name, else none.
    const shownId = options.fullId
      ? run.id
      : sharedNames.has(run.name)
        ? shortRunId(run.id)
        : undefined;
    const treeRow = treeRows?.[index];
    const branch = treeRow ? runTreeBranch(treeRow) : "";
    const awaited = options.hierarchy?.awaitedRunIds?.has(run.id) ? "◎ " : "";
    const name = `${branch}${awaited}${glyph} ${sanitizeTerminalLine(run.name)}`;
    const themedName = theme.fg(runStateColor(run.state), name);
    const id = shownId === undefined ? undefined : sanitizeTerminalLine(shownId);
    return {
      run,
      identity:
        id === undefined
          ? { plain: name, themed: themedName }
          : {
              plain: `${name} · ${id}`,
              themed: `${themedName}${theme.fg("dim", " · ")}${theme.fg("muted", id)}`,
            },
      intent: sanitizeTerminalLine(run.writeIntent),
      state: sanitizeTerminalLine(
        [runStateLabel(run.state), run.currentTool, runTiming(run)].filter(Boolean).join(" · "),
      ),
      usage: aggregateUsage([run], "compact"),
    };
  });
  if (treeRows) return rows.map((row) => renderHierarchyRow(row, safeWidth, theme));
  const routes = displayRuns.map((run) => formatRunRouteLine(run));
  const intentWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.intent)), 0);
  const identityWidth = Math.min(
    Math.max(16, ...rows.map((row) => visibleWidth(row.identity.plain))),
    Math.max(16, Math.floor(safeWidth * 0.28)),
  );
  const stateWidth = Math.min(
    Math.max(14, ...rows.map((row) => visibleWidth(row.state))),
    Math.max(14, Math.floor(safeWidth * 0.28)),
  );
  const hasUsage = rows.some((row) => Boolean(row.usage));
  const usageWidth = hasUsage
    ? Math.min(
        Math.max(...rows.map((row) => visibleWidth(row.usage))),
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
    return rows.map((row) => {
      const color = runStateColor(row.run.state);
      const identity = clipToWidth(row.identity.themed, identityWidth);
      const route = formatRunRouteLine(row.run, theme);
      const intent = theme.fg(row.run.writeIntent === "writer" ? "warning" : "muted", row.intent);
      const usage = theme.fg("muted", clipToWidth(row.usage, usageWidth));
      const state = theme.fg(color, clipToWidth(row.state, stateWidth));
      const usageColumn = hasUsage ? ` · ${padVisible(usage, usageWidth)}` : "";
      return `${padVisible(identity, identityWidth)} · ${padVisible(route, routeWidth)} · ${padVisible(intent, intentWidth)}${usageColumn} · ${padVisible(state, stateWidth)}`;
    });
  return rows.flatMap(({ run, identity, usage }) => {
    const color = runStateColor(run.state);
    const compactStatus = [
      runStateLabel(run.state),
      run.currentTool ? sanitizeTerminalLine(run.currentTool) : undefined,
      run.writeIntent === "writer" ? "writer" : undefined,
      usage,
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
