import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { managerLayoutTier, type ManagerLayoutTier } from "pi-cosmic-ui/manager";
import {
  isAssignmentFinishedRunState,
  type SubagentProjection,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import { fleetTreeBranch, projectFleetTree, type FleetTreeRow } from "./fleet-tree.ts";
import { aggregateUsage, formatDuration } from "./metrics.ts";
import { animatedRunStateGlyph, runStateColor, runStateLabel } from "./run-state.ts";

const MAX_SESSION_DISPLAY_AGE = 7 * 24 * 60 * 60 * 1_000;
const RUN_ID_COLLATOR = new Intl.Collator("en", { numeric: true });

export type SubagentActivityAwaitMode = "all_finished" | "any_finished";

export interface SubagentActivityPresentationSnapshot {
  readonly revision: number;
  readonly starts: ReadonlyArray<{ readonly requestedCount: number }>;
  readonly awaits: ReadonlyArray<{
    readonly runIds: ReadonlyArray<string>;
    readonly until: SubagentActivityAwaitMode;
  }>;
}

export const emptyActivityPresentation = (): SubagentActivityPresentationSnapshot => ({
  revision: 0,
  starts: [],
  awaits: [],
});

const PANEL_RUN_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "running",
  "waiting_for_parent",
  "paused",
  "stopping",
]);

export const isActivityPanelRunState = (state: SubagentRunState): boolean =>
  PANEL_RUN_STATES.has(state);

export interface SubagentActivityPanelProjection {
  readonly rows: ReadonlyArray<FleetTreeRow>;
  /** Runs that keep the panel visible. Ancestor-only context is excluded. */
  readonly trackedRuns: ReadonlyArray<SubagentRunView>;
  readonly trackedRunIds: ReadonlySet<string>;
  readonly awaitedRunIds: ReadonlySet<string>;
  readonly awaitedRuns: ReadonlyArray<SubagentRunView>;
  readonly retainedCount: number;
  readonly presentation: SubagentActivityPresentationSnapshot;
}

export const projectSubagentActivityPanel = (
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = emptyActivityPresentation(),
): SubagentActivityPanelProjection => {
  const trackedRuns = projection.runs.filter((run) => isActivityPanelRunState(run.state));
  const includedIds = new Set(trackedRuns.map((run) => run.id));
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));

  for (const run of trackedRuns) {
    const visited = new Set<string>([run.id]);
    let parentId = run.parentRunId;
    while (parentId && parentId !== "root" && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = runsById.get(parentId);
      if (!parent) break;
      includedIds.add(parent.id);
      parentId = parent.parentRunId;
    }
  }

  const includedRuns = projection.runs
    .filter((run) => includedIds.has(run.id))
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt || RUN_ID_COLLATOR.compare(left.id, right.id),
    );
  const tree = projectFleetTree(includedRuns, "root", new Set());
  const awaitedRunIds = new Set(presentation.awaits.flatMap((awaiting) => awaiting.runIds));
  return {
    rows: tree.rows,
    trackedRuns,
    trackedRunIds: new Set(trackedRuns.map((run) => run.id)),
    awaitedRunIds,
    awaitedRuns: projection.runs.filter((run) => awaitedRunIds.has(run.id)),
    retainedCount: projection.runs.filter((run) => run.state === "reported").length,
    presentation,
  };
};

export const hasSubagentActivityPanelContent = (
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot = emptyActivityPresentation(),
): boolean =>
  projection.runs.some((run) => isActivityPanelRunState(run.state)) ||
  presentation.starts.length > 0 ||
  presentation.awaits.length > 0;

export const subagentActivityPanelCadence = (
  panel: SubagentActivityPanelProjection,
): number | undefined => {
  if (
    panel.rows.length === 0 &&
    panel.presentation.starts.length === 0 &&
    panel.presentation.awaits.length === 0
  )
    return undefined;
  return panel.trackedRuns.some((run) => run.state === "starting" || run.state === "running") ||
    panel.presentation.starts.length > 0
    ? 160
    : 1_000;
};

const shortRunId = (id: string): string => (id.length <= 14 ? id : `…${id.slice(-13)}`);

const runElapsed = (run: SubagentRunView, now: number): string => {
  const end = run.endedAt ?? now;
  const age = end - run.startedAt;
  return Number.isFinite(age) && age >= 0 && age <= MAX_SESSION_DISPLAY_AGE
    ? formatDuration(age)
    : "";
};

const runActivity = (run: SubagentRunView): string => {
  if (run.state === "waiting_for_parent" || run.state === "paused") return runStateLabel(run.state);
  if (run.state !== "running") return "";
  return sanitizeTerminalLine(run.currentTool ?? run.progress ?? "");
};

type HeaderColor = "accent" | "success" | "warning" | "muted" | "dim";
type HeaderPart = readonly [color: HeaderColor, text: string];

const panelHeader = (panel: SubagentActivityPanelProjection, theme: Theme): string => {
  const { trackedRuns, presentation } = panel;
  const working = trackedRuns.filter(
    (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
  ).length;
  const waiting = trackedRuns.filter((run) => run.state === "waiting_for_parent").length;
  const paused = trackedRuns.filter((run) => run.state === "paused").length;
  const usage = aggregateUsage(trackedRuns, "compact");
  const awaitIds = [...panel.awaitedRunIds];
  const finishedTargets = panel.awaitedRuns.filter((run) =>
    isAssignmentFinishedRunState(run.state),
  ).length;
  const startCount = presentation.starts.reduce(
    (total, starting) => total + starting.requestedCount,
    0,
  );
  const awaitProgress =
    presentation.awaits.length === 1 && presentation.awaits[0]?.until === "any_finished"
      ? `first of ${awaitIds.length}`
      : awaitIds.length > 0
        ? `${finishedTargets}/${awaitIds.length}`
        : undefined;
  const parts: HeaderPart[] = [["success", "Subagents"]];
  if (awaitProgress) parts.push(["accent", awaitProgress]);
  if (startCount > 0) parts.push(["accent", `${startCount} starting`]);
  if (working > 0) parts.push(["muted", `${working} working`]);
  if (waiting > 0) parts.push(["warning", `${waiting} waiting`]);
  if (paused > 0) parts.push(["warning", `${paused} paused`]);
  if (panel.retainedCount > 0) parts.push(["muted", `${panel.retainedCount} retained`]);
  if (usage) parts.push(["muted", usage]);
  parts.push(["dim", "/subagents"]);
  const separator = theme.fg("dim", " · ");
  return parts.map(([color, text]) => theme.fg(color, text)).join(separator);
};

const renderActivityRow = (
  row: FleetTreeRow,
  panel: SubagentActivityPanelProjection,
  width: number,
  tier: ManagerLayoutTier,
  theme: Theme,
  now: number,
  frame: number,
  duplicateNames: ReadonlySet<string>,
): string => {
  const { run } = row;
  const ancestorOnly = !panel.trackedRunIds.has(run.id);
  const identityColor = ancestorOnly ? "dim" : runStateColor(run.state);
  const branch = fleetTreeBranch(row);
  const awaited = panel.awaitedRunIds.has(run.id) ? "◎ " : "";
  const name = sanitizeTerminalLine(run.name);
  const stateIdentity = `${awaited}${animatedRunStateGlyph(run.state, frame)} ${name}`;
  const id = duplicateNames.has(run.name)
    ? `${theme.fg("dim", " · ")}${theme.fg(
        ancestorOnly ? "dim" : "muted",
        shortRunId(sanitizeTerminalLine(run.id)),
      )}`
    : "";
  const identity = `${theme.fg("success", branch)}${theme.fg(identityColor, stateIdentity)}${id}`;
  if (ancestorOnly) return truncateToWidth(identity, width, "");
  const activity = runActivity(run);
  const attention = run.state === "waiting_for_parent" || run.state === "paused";
  const profile = theme.fg("muted", sanitizeTerminalLine(run.profile ?? "generalist"));
  const themedActivity = activity ? theme.fg(attention ? "warning" : "accent", activity) : "";
  const elapsed = runElapsed(run, now);
  const themedElapsed = elapsed ? theme.fg("dim", elapsed) : "";
  const separator = theme.fg("dim", " · ");
  const metadataVariants = (() => {
    if (tier === "wide")
      return [
        [profile, themedActivity, themedElapsed],
        [themedActivity, themedElapsed],
        [themedActivity],
      ];
    if (tier === "stacked") return [[themedActivity, themedElapsed], [themedActivity]];
    return attention ? [[themedActivity]] : [];
  })()
    .map((parts) => parts.filter(Boolean).join(separator))
    .filter(Boolean);

  for (const metadata of metadataVariants) {
    const combined = `${identity}${separator}${metadata}`;
    if (visibleWidth(combined) <= width) return combined;
  }

  const fallbackActivity = attention ? themedActivity : "";
  if (!fallbackActivity || width < 12) return truncateToWidth(identity, width, "");
  const maximumMetadataWidth = width - 3 - 8;
  if (maximumMetadataWidth < 6) return truncateToWidth(identity, width, "");
  const metadataWidth = Math.min(
    visibleWidth(fallbackActivity),
    maximumMetadataWidth,
    Math.max(6, Math.floor(width * 0.38)),
  );
  const identityWidth = width - metadataWidth - 3;
  return `${truncateToWidth(identity, identityWidth, "")}${separator}${truncateToWidth(fallbackActivity, metadataWidth, "")}`;
};

export const renderSubagentActivityPanel = (
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationSnapshot,
  width: number,
  theme: Theme,
  now: number,
): string[] => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return [];
  const panel = projectSubagentActivityPanel(projection, presentation);
  if (
    panel.rows.length === 0 &&
    presentation.starts.length === 0 &&
    presentation.awaits.length === 0
  )
    return [];
  const inset = safeWidth > 1 ? " " : "";
  const contentWidth = safeWidth - visibleWidth(inset);
  const tier = managerLayoutTier(safeWidth);
  const frame = Math.floor(now / 160);
  const nameCounts = new Map<string, number>();
  for (const row of panel.rows)
    nameCounts.set(row.run.name, (nameCounts.get(row.run.name) ?? 0) + 1);
  const duplicateNames = new Set(
    [...nameCounts].flatMap(([name, count]) => (count > 1 ? [name] : [])),
  );
  return [
    `${inset}${truncateToWidth(panelHeader(panel, theme), contentWidth, "")}`,
    ...panel.rows.map(
      (row) =>
        `${inset}${renderActivityRow(
          row,
          panel,
          contentWidth,
          tier,
          theme,
          now,
          frame,
          duplicateNames,
        )}`,
    ),
  ];
};
