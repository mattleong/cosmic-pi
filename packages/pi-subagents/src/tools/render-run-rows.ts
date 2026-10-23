import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { synchronousNow } from "pi-cosmic-core/platform/native-clock";
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
import { isTextFragment } from "./text-fragments.ts";

export const runTiming = (run: {
  readonly endedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly startedAt?: number | undefined;
}): string => {
  const now = synchronousNow();
  const elapsed = formatSessionAge(run.endedAt ?? now, run.startedAt);
  const activeAge = run.endedAt === undefined ? formatSessionActivity(now, run.lastActivityAt) : "";
  const active = activeAge ? `active ${activeAge}` : "";
  return Fn.pipe([elapsed, active], Arr.filter(Boolean), Arr.join(" · "));
};

const padVisible = (value: string, width: number): string =>
  `${value}${Fn.pipe(" ", Str.repeat(Math.max(0, width - visibleWidth(value))))}`;

const renderRouteRail = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const prefix = width > 5 ? "     " : "   ";
  const available = Math.max(1, width - visibleWidth(prefix));
  const routeLines = wrapTextWithAnsi(formatRunRouteLine(run, theme), available);
  return Arr.map(routeLines, (line) => clipToWidth(`${prefix}${line}`, width));
};

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
  const metadata = Fn.pipe(
    [
      formatRunRouteLine(run, theme),
      run.writeIntent === "writer" ? theme.fg("warning", "writer") : undefined,
      usage ? theme.fg("muted", usage) : undefined,
      run.currentTool ? theme.fg("accent", sanitizeTerminalLine(run.currentTool)) : undefined,
      timing ? theme.fg("muted", timing) : undefined,
    ],
    Arr.filter(Predicate.isNotUndefined),
    Arr.join(theme.fg("dim", " · ")),
  );
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
  const displayRuns = treeRows === undefined ? runs : Arr.map(treeRows, (row) => row.run);
  const sharedNames = duplicateRunNames(displayRuns);
  const rows = Arr.map(displayRuns, (run, index): RunRow => {
    const glyph = runStateGlyph(run.state, options.frame);
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
        Fn.pipe(
          [runStateLabel(run.state), run.currentTool, runTiming(run)],
          Arr.filter(isTextFragment),
          Arr.join(" · "),
        ),
      ),
      usage: aggregateUsage([run], "compact"),
    };
  });
  if (treeRows) return Arr.map(rows, (row) => renderHierarchyRow(row, safeWidth, theme));
  const routes = Arr.map(displayRuns, (run) => formatRunRouteLine(run));
  const intentWidth = Arr.reduce(rows, 0, (max, row) => Math.max(max, visibleWidth(row.intent)));
  const identityWidth = Math.min(
    Math.max(16, ...Arr.map(rows, (row) => visibleWidth(row.identity.plain))),
    Math.max(16, Math.floor(safeWidth * 0.28)),
  );
  const stateWidth = Math.min(
    Math.max(14, ...Arr.map(rows, (row) => visibleWidth(row.state))),
    Math.max(14, Math.floor(safeWidth * 0.28)),
  );
  const hasUsage = Arr.some(rows, (row) => Boolean(row.usage));
  const usageWidth = hasUsage
    ? Math.min(
        Math.max(...Arr.map(rows, (row) => visibleWidth(row.usage))),
        Math.max(8, Math.floor(safeWidth * 0.18)),
      )
    : 0;
  const routeWidth =
    safeWidth - identityWidth - intentWidth - stateWidth - usageWidth - (hasUsage ? 12 : 9);
  if (
    safeWidth >= 88 &&
    routeWidth >= 12 &&
    Arr.every(routes, (route) => visibleWidth(route) <= routeWidth)
  )
    return Arr.map(rows, (row) => {
      const color = runStateColor(row.run.state);
      const identity = clipToWidth(row.identity.themed, identityWidth);
      const route = formatRunRouteLine(row.run, theme);
      const intent = theme.fg(row.run.writeIntent === "writer" ? "warning" : "muted", row.intent);
      const usage = theme.fg("muted", clipToWidth(row.usage, usageWidth));
      const state = theme.fg(color, clipToWidth(row.state, stateWidth));
      const usageColumn = hasUsage ? ` · ${padVisible(usage, usageWidth)}` : "";
      return `${padVisible(identity, identityWidth)} · ${padVisible(route, routeWidth)} · ${padVisible(intent, intentWidth)}${usageColumn} · ${padVisible(state, stateWidth)}`;
    });
  return Arr.flatMap(rows, ({ run, identity, usage }) => {
    const color = runStateColor(run.state);
    const compactStatus = Fn.pipe(
      [
        runStateLabel(run.state),
        run.currentTool ? sanitizeTerminalLine(run.currentTool) : undefined,
        run.writeIntent === "writer" ? "writer" : undefined,
        usage,
      ],
      Arr.filter(isTextFragment),
      Arr.join(" · "),
    );
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
    return [identityLine].concat(renderRouteRail(run, safeWidth, theme));
  });
};
