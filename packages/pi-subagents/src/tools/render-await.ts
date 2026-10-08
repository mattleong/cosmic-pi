import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import {
  invokeHostCallback,
  sanitizeTerminalLine,
  synchronousNow,
  countLabel,
} from "pi-cosmic-core";
import { clipToWidth, spinnerFrameAt, SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { runStateGlyph, runStateLabel } from "../ui/run-state.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import type { SubagentRunCard, SubagentStartAwaitCardDetails } from "./details-schema.ts";
import { composeToolComponent as renderComponent } from "pi-cosmic-ui/tool";
import { renderResponsiveRunRows, runTiming, type RunHierarchy } from "./render-run-rows.ts";

export interface AwaitProgressRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunCard["state"];
  readonly parentRunId?: string | undefined;
  readonly currentTool?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly usage?: { readonly totalTokens: number; readonly cost?: number | undefined } | undefined;
}

/** An await's run hierarchy, which always names its awaited targets. */
export interface AwaitHierarchy extends RunHierarchy {
  readonly awaitedRunIds: ReadonlySet<string>;
}

const firstFinishedSummary = (run: AwaitProgressRun): string =>
  `${sanitizeTerminalLine(run.name)} ${runStateLabel(run.state)} first`;

/** First finished run by earliest end time; relevant only for any_finished waits. */
const firstFinishedRun = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
): AwaitProgressRun | undefined =>
  until === "any_finished"
    ? runs
        .filter((run) => isAssignmentFinishedRunState(run.state))
        .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity))[0]
    : undefined;

const ACTIVE_STATES = ["starting", "running", "waiting_for_parent", "paused", "stopping"] as const;

/** Each nonzero state count in the run rows' words: "2 running", "1 failed". */
const stateCounts = (
  runs: ReadonlyArray<AwaitProgressRun>,
  states: ReadonlyArray<AwaitProgressRun["state"]>,
): string[] =>
  states.flatMap((state) => {
    const count = runs.filter((run) => run.state === state).length;
    return count > 0 ? [`${count} ${runStateLabel(state)}`] : [];
  });

/**
 * The wait's routine counters for people: finished targets apart from failed and stopped
 * ones, then usage. Outcomes and problems are the shell's issue lines, not repeated here.
 */
export const formatAwaitCounters = (
  cards: ReadonlyArray<SubagentRunCard>,
  { awaitedRunIds }: AwaitHierarchy,
  until: SubagentAwaitUntil,
  settled = false,
): string => {
  const targets = cards.filter((card) => awaitedRunIds.has(card.id));
  const first = settled ? firstFinishedRun(targets, until) : undefined;
  const done = targets.filter((run) => run.state === "completed");
  const usage = aggregateUsage(cards, "compact");
  const descendantCount = cards.length - targets.length;
  return [
    ...(first ? [firstFinishedSummary(first)] : []),
    `${done.length}/${awaitedRunIds.size} finished`,
    ...stateCounts(targets, [...ACTIVE_STATES, "failed", "stopped"]),
    ...(usage ? [usage] : []),
    ...(descendantCount > 0 ? [countLabel(descendantCount, "descendant")] : []),
  ].join(" · ");
};

/** The agent's live await text: one summary line, then the run tree with awaited targets marked. */
export const formatAwaitProgress = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
  contextRuns: ReadonlyArray<AwaitProgressRun> = [],
): string => {
  const awaitedIds = new Set(runs.map((run) => run.id));
  const allRuns = [...runs, ...contextRuns.filter((run) => !awaitedIds.has(run.id))];
  const usage = aggregateUsage(allRuns, "compact");
  const finished = runs.filter((run) => isAssignmentFinishedRunState(run.state)).length;
  const first = firstFinishedRun(runs, until);
  const descendantCount = allRuns.length - runs.length;
  const summary = [
    until === "all_finished" ? "Waiting for subagents" : "Waiting for first subagent",
    ...(awaitedIds.size > 0 ? [`${finished}/${awaitedIds.size}`] : []),
    ...(first ? [firstFinishedSummary(first)] : []),
    ...stateCounts(runs, [...ACTIVE_STATES, "failed"]),
    ...(usage ? [usage] : []),
    `◎${countLabel(awaitedIds.size, "target")}`,
    ...(descendantCount > 0 ? [countLabel(descendantCount, "descendant")] : []),
  ].join(" · ");
  return [
    summary,
    ...projectRunCardTree(allRuns).map((row) => {
      const status = sanitizeTerminalLine(
        [row.run.currentTool, runTiming(row.run)].filter(Boolean).join(" · "),
      );
      return `${runTreeBranch(row)}${awaitedIds.has(row.run.id) ? "◎ " : ""}${runStateGlyph(row.run.state)} ${sanitizeTerminalLine(row.run.name)} (${sanitizeTerminalLine(row.run.id)})${status ? ` · ${status}` : ""}`;
    }),
  ].join("\n");
};

interface SubagentToolRendererState extends Record<string, unknown> {
  piSubagentsAwaitTicker?: (() => void) | undefined;
  piSubagentsAwaitInvalidate?: (() => void) | undefined;
}

export interface SubagentToolRenderContext {
  readonly state: SubagentToolRendererState;
  readonly invalidate: () => void;
}

export const syncAwaitProgressTicker = (
  details: SubagentStartAwaitCardDetails | undefined,
  isPartial: boolean,
  context: SubagentToolRenderContext | undefined,
  startTicker: (intervalMs: number, tick: () => void) => () => void,
): void => {
  if (!context?.state) return;
  const shouldAnimate =
    isPartial &&
    (details?.action === "start" ||
      (details?.action === "await" &&
        details.cancelled !== true &&
        details.cards.some((run) => run.state === "starting" || run.state === "running")));
  if (shouldAnimate) {
    context.state.piSubagentsAwaitInvalidate = context.invalidate;
    if (!context.state.piSubagentsAwaitTicker) {
      const weakState = new WeakRef(context.state);
      let stopTimer = () => {};
      const cleanup = () => invokeHostCallback(stopTimer, undefined);
      stopTimer = startTicker(SPINNER_FRAME_MS, () => {
        const active = weakState.deref();
        if (active) active.piSubagentsAwaitInvalidate?.();
        else cleanup();
      });
      context.state.piSubagentsAwaitTicker = cleanup;
    }
    return;
  }
  const stop = context.state.piSubagentsAwaitTicker;
  if (!stop) return;
  context.state.piSubagentsAwaitTicker = undefined;
  context.state.piSubagentsAwaitInvalidate = undefined;
  invokeHostCallback(stop, undefined);
};

/** A bounded hierarchy says so in passing; which descendants matter is the fleet's job. */
export const DESCENDANTS_OMITTED = "Some descendants are not shown";

export const renderAwaitProgressComponent = (
  cards: ReadonlyArray<SubagentRunCard>,
  until: SubagentAwaitUntil,
  theme: Theme,
  hierarchy: AwaitHierarchy,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const frame = spinnerFrameAt(synchronousNow());
    const counters = formatAwaitCounters(cards, hierarchy, until);
    return [
      clipToWidth(theme.fg("muted", counters), safeWidth),
      ...(hierarchy.contextOmitted
        ? [clipToWidth(theme.fg("dim", DESCENDANTS_OMITTED), safeWidth)]
        : []),
      ...renderResponsiveRunRows(cards, safeWidth, theme, { frame, hierarchy }),
    ];
  });
