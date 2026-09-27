import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import {
  managerLayoutTier,
  type ManagerLayoutTier,
  clipToWidth,
  spinnerFrameAt,
} from "pi-cosmic-ui/manager";
import {
  isAssignmentFinishedRunState,
  type SubagentProjection,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import { aggregateUsage } from "./metrics.ts";
import { subagentUiRefreshCadence, type SubagentUiRefreshCadence } from "./refresh.ts";
import {
  formatRunRouteLine,
  formatSessionAge,
  projectRunRoutePresentation,
  shortRunId,
} from "./run-presentation.ts";
import { projectFleetTree, runTreeBranch, type FleetTreeRow } from "./run-tree-rows.ts";
import { animatedRunStateGlyph, runStateColor, runStateLabel } from "./run-state.ts";

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
): SubagentUiRefreshCadence | undefined =>
  subagentUiRefreshCadence(panel.trackedRuns, { includePausedElapsed: true });

const runElapsed = (run: SubagentRunView, now: number): string =>
  formatSessionAge(run.endedAt ?? now, run.startedAt);

const runActivity = (run: SubagentRunView): string => {
  if (run.state === "waiting_for_parent" || run.state === "paused") return runStateLabel(run.state);
  if (run.state !== "running") return "";
  return sanitizeTerminalLine(run.currentTool ?? run.progress ?? "");
};

type HeaderColor = "accent" | "success" | "warning" | "muted" | "dim";

interface HeaderPart {
  readonly color: HeaderColor;
  readonly text: string;
}

interface OptionalHeaderPart extends HeaderPart {
  /** Lower values survive longer when the header must shed detail. */
  readonly priority: number;
}

const renderHeaderParts = (parts: ReadonlyArray<HeaderPart>, theme: Theme): string => {
  const separator = theme.fg("dim", " · ");
  return parts.map((part) => theme.fg(part.color, part.text)).join(separator);
};

const fitPanelHeader = (
  optionalParts: ReadonlyArray<OptionalHeaderPart>,
  width: number,
  theme: Theme,
): string => {
  const title: HeaderPart = { color: "success", text: "Subagents" };
  const command: HeaderPart = { color: "dim", text: "/subagents" };
  const remaining = [...optionalParts];
  for (;;) {
    const rendered = renderHeaderParts([title, ...remaining, command], theme);
    if (visibleWidth(rendered) <= width) return rendered;
    if (remaining.length === 0) break;
    const lowestValue = Math.max(...remaining.map((part) => part.priority));
    let removeIndex = remaining.length - 1;
    while (removeIndex > 0 && remaining[removeIndex]?.priority !== lowestValue) removeIndex -= 1;
    remaining.splice(removeIndex, 1);
  }
  const commandOnly = theme.fg(command.color, command.text);
  return visibleWidth(commandOnly) <= width ? commandOnly : clipToWidth(commandOnly, width, "");
};

const panelHeader = (
  panel: SubagentActivityPanelProjection,
  width: number,
  theme: Theme,
): string => {
  const { trackedRuns, presentation } = panel;
  const active = trackedRuns.filter(
    (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
  ).length;
  const waiting = trackedRuns.filter((run) => run.state === "waiting_for_parent").length;
  const paused = trackedRuns.filter((run) => run.state === "paused").length;
  const usage = aggregateUsage(trackedRuns, "compact");
  const awaitedRunsById = new Map(panel.awaitedRuns.map((run) => [run.id, run]));
  const awaitParts: OptionalHeaderPart[] = [];
  if (presentation.awaits.length > 1)
    awaitParts.push({
      color: "accent",
      text: `${presentation.awaits.length} waits`,
      priority: 2,
    });
  for (const awaiting of presentation.awaits) {
    const runIds = [...new Set(awaiting.runIds)];
    const finished = runIds.filter((runId) => {
      const run = awaitedRunsById.get(runId);
      return run !== undefined && isAssignmentFinishedRunState(run.state);
    }).length;
    awaitParts.push({
      color: "accent",
      text:
        awaiting.until === "any_finished"
          ? `first of ${runIds.length}`
          : presentation.awaits.length === 1
            ? `${finished}/${runIds.length} awaited`
            : `all ${finished}/${runIds.length}`,
      priority: 1,
    });
  }
  const startCount = presentation.starts.reduce(
    (total, starting) => total + starting.requestedCount,
    0,
  );
  return fitPanelHeader(
    [
      ...awaitParts,
      ...(startCount > 0
        ? [{ color: "accent" as const, text: `launching ${startCount}`, priority: 1 }]
        : []),
      ...(active > 0 ? [{ color: "muted" as const, text: `${active} active`, priority: 2 }] : []),
      ...(waiting > 0
        ? [{ color: "warning" as const, text: `${waiting} waiting`, priority: 0 }]
        : []),
      ...(paused > 0 ? [{ color: "warning" as const, text: `${paused} paused`, priority: 0 }] : []),
      ...(panel.retainedCount > 0
        ? [{ color: "muted" as const, text: `${panel.retainedCount} retained`, priority: 3 }]
        : []),
      ...(usage ? [{ color: "muted" as const, text: usage, priority: 4 }] : []),
    ],
    width,
    theme,
  );
};

type RunRouteLayout = "full" | "compact" | "model";

const renderRunRoute = (
  run: SubagentRunView,
  theme: Theme,
  layout: RunRouteLayout,
  dimmed: boolean,
): string => {
  if (layout === "full")
    return dimmed ? theme.fg("dim", formatRunRouteLine(run)) : formatRunRouteLine(run, theme);
  const { profile, hostRuntime, model, narrowModel } = projectRunRoutePresentation(run);
  const plain =
    layout === "model" ? `${profile} · ${narrowModel}` : `${profile} ${hostRuntime} ${model}`;
  if (dimmed) return theme.fg("dim", plain);
  return layout === "model"
    ? `${theme.fg("muted", profile)}${theme.fg("dim", " · ")}${theme.fg("toolOutput", narrowModel)}`
    : `${theme.fg("muted", profile)} ${theme.fg("toolOutput", `${hostRuntime} ${model}`)}`;
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
  const branch = runTreeBranch(row);
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
  const routeLayout: RunRouteLayout = tier === "wide" ? "full" : "model";
  const route = renderRunRoute(run, theme, routeLayout, ancestorOnly);
  const compactRoute = renderRunRoute(
    run,
    theme,
    tier === "wide" ? "compact" : "model",
    ancestorOnly,
  );
  const activity = ancestorOnly ? "" : runActivity(run);
  const attention = run.state === "waiting_for_parent" || run.state === "paused";
  const themedActivity = activity ? theme.fg(attention ? "warning" : "accent", activity) : "";
  const elapsed = ancestorOnly ? "" : runElapsed(run, now);
  const themedElapsed = elapsed ? theme.fg("dim", elapsed) : "";
  const separator = theme.fg("dim", " · ");
  const metadataVariants = [
    [route, themedActivity, themedElapsed],
    [route, themedActivity],
    [route, themedElapsed],
    [route],
  ]
    .map((parts) => parts.filter(Boolean).join(separator))
    .filter(Boolean);

  for (const metadata of metadataVariants) {
    const combined = `${identity}${separator}${metadata}`;
    if (visibleWidth(combined) <= width) return combined;
  }

  if (width < 12) return clipToWidth(identity, width, "");
  const minimumIdentityWidth = tier === "narrow" ? 6 : 8;
  const maximumRouteWidth = width - minimumIdentityWidth - visibleWidth(separator);
  if (maximumRouteWidth < 8) return clipToWidth(identity, width, "");
  const routeWidth = Math.min(visibleWidth(compactRoute), maximumRouteWidth);
  const identityWidth = width - routeWidth - visibleWidth(separator);
  return `${clipToWidth(identity, identityWidth, "")}${separator}${clipToWidth(compactRoute, routeWidth, "")}`;
};

export const renderProjectedSubagentActivityPanel = (
  panel: SubagentActivityPanelProjection,
  width: number,
  theme: Theme,
  now: number,
): string[] => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return [];
  if (
    panel.rows.length === 0 &&
    panel.presentation.starts.length === 0 &&
    panel.presentation.awaits.length === 0
  )
    return [];
  const inset = safeWidth > 1 ? " " : "";
  const contentWidth = safeWidth - visibleWidth(inset);
  const tier = managerLayoutTier(safeWidth);
  const frame = spinnerFrameAt(now);
  const nameCounts = new Map<string, number>();
  for (const row of panel.rows)
    nameCounts.set(row.run.name, (nameCounts.get(row.run.name) ?? 0) + 1);
  const duplicateNames = new Set(
    [...nameCounts].flatMap(([name, count]) => (count > 1 ? [name] : [])),
  );
  return [
    `${inset}${panelHeader(panel, contentWidth, theme)}`,
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
