import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { synchronousNow } from "pi-cosmic-core/platform/native-clock";
import { countLabel } from "pi-cosmic-core/display";
import { clipToWidth, spinnerFrameAt, SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";
import { isTerminalRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { runStateColor, runStateGlyph, runStateLabel } from "../ui/run-state.ts";
import { factRowLines } from "../ui/agent-text.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import type { CompactChild, CompactStatus, CompactSummary } from "pi-code-previews";
import type { SubagentRunCard, SubagentStartAwaitCardDetails } from "./details-schema.ts";
import { composeToolComponent as renderComponent } from "pi-cosmic-ui/tool";
import { runTiming } from "./render-run-rows.ts";
import { isTextFragment } from "./text-fragments.ts";

interface AwaitProgressRun {
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

interface AwaitHierarchy {
  readonly awaitedRunIds: ReadonlySet<string>;
  readonly contextOmitted?: boolean | undefined;
}

const firstFinishedSummary = (run: AwaitProgressRun): string =>
  `${sanitizeTerminalLine(run.name)} ${runStateLabel(run.state)} first`;

const firstFinishedRun = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
): AwaitProgressRun | undefined =>
  until === "any_finished"
    ? Fn.pipe(
        runs,
        Arr.filter((run) => isTerminalRunState(run.state)),
        Arr.sortWith((run) => run.endedAt ?? Infinity, Order.Number),
      )[0]
    : undefined;

const ACTIVE_STATES = ["starting", "running", "waiting_for_parent", "paused", "stopping"] as const;

const stateCounts = (
  runs: ReadonlyArray<AwaitProgressRun>,
  states: ReadonlyArray<AwaitProgressRun["state"]>,
): string[] =>
  Arr.flatMap(states, (state) => {
    const count = Arr.countBy(runs, (run) => run.state === state);
    return count > 0 ? [`${count} ${runStateLabel(state)}`] : [];
  });

/** The states whose counts a compact await heading shows beside how many finished. */
const HEADING_COUNTED_STATES: ReadonlyArray<AwaitProgressRun["state"]> = ["failed", "stopped"];

/** What a row's heading drew above an await body. */
export interface AwaitHeading {
  /** A compact heading, whose glyph states a single awaited run's state. */
  readonly compact: boolean;
  /** Whether it drew its counter: how many finished, failed, and stopped. */
  readonly counted: boolean;
}

/**
 * An await body's totals: the first run to finish, how many finished and in which states, usage,
 * and descendants. Counts the row already shows are left out: a single awaited run's glyph is its
 * count, and a compact heading that drew its counter shows how many finished, failed, and stopped.
 * A preview heading, or a compact one too narrow for its counter, shows no counts, so its body
 * keeps the rest; while a wait runs, its run rows are a tree that states each run's own state, so
 * under a preview heading a single run's state count stays there too.
 */
export const formatAwaitCounters = (
  cards: ReadonlyArray<SubagentRunCard>,
  { awaitedRunIds }: AwaitHierarchy,
  until: SubagentAwaitUntil,
  {
    settled = false,
    heading = { compact: false, counted: false },
    usage: withUsage = true,
  }: {
    settled?: boolean;
    heading?: AwaitHeading | undefined;
    /** Whether the totals carry usage, which an expanded wait keeps in its `Details`. */
    usage?: boolean;
  } = {},
): string => {
  const targets = Arr.filter(cards, (card) => awaitedRunIds.has(card.id));
  const first = settled ? firstFinishedRun(targets, until) : undefined;
  const done = Arr.filter(targets, (run) => run.state === "completed");
  const usage = aggregateUsage(cards);
  const descendantCount = cards.length - targets.length;
  const single = awaitedRunIds.size === 1 && targets.length === 1;
  const counted = Arr.filter(
    [...ACTIVE_STATES, "failed", "stopped"] as const,
    (state) => !(heading.counted && Arr.contains(HEADING_COUNTED_STATES, state)),
  );
  return Arr.join(
    [
      ...(first ? [firstFinishedSummary(first)] : []),
      ...(single || heading.counted ? [] : [`${done.length}/${awaitedRunIds.size} finished`]),
      ...(single && (settled || heading.compact) ? [] : stateCounts(targets, counted)),
      ...(usage && withUsage ? [usage] : []),
      ...(descendantCount > 0 ? [countLabel(descendantCount, "descendant")] : []),
    ],
    " · ",
  );
};

const progressRuns = (
  runs: ReadonlyArray<AwaitProgressRun>,
  contextRuns: ReadonlyArray<AwaitProgressRun>,
) => {
  const awaitedIds = new Set(Arr.map(runs, (run) => run.id));
  return {
    awaitedIds,
    allRuns: [...runs, ...Arr.filter(contextRuns, (run) => !awaitedIds.has(run.id))],
  };
};

/** One line: how many awaited runs finished, their states, usage, and descendants. */
export const formatAwaitSummary = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
  contextRuns: ReadonlyArray<AwaitProgressRun> = [],
): string => {
  const { awaitedIds, allRuns } = progressRuns(runs, contextRuns);
  const usage = aggregateUsage(allRuns);
  const finished = Arr.countBy(runs, (run) => isTerminalRunState(run.state));
  const first = firstFinishedRun(runs, until);
  const descendantCount = allRuns.length - runs.length;
  return Arr.join(
    [
      until === "all_finished" ? "Waiting for subagents" : "Waiting for first subagent",
      ...(awaitedIds.size > 0 ? [`${finished}/${awaitedIds.size}`] : []),
      ...(first ? [firstFinishedSummary(first)] : []),
      ...stateCounts(runs, [...ACTIVE_STATES, "failed"]),
      ...(usage ? [usage] : []),
      `◎${countLabel(awaitedIds.size, "target")}`,
      ...(descendantCount > 0 ? [countLabel(descendantCount, "descendant")] : []),
    ],
    " · ",
  );
};

/** The summary, then one row per run of the awaited hierarchy. */
export const formatAwaitProgress = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
  contextRuns: ReadonlyArray<AwaitProgressRun> = [],
): string => {
  const { awaitedIds, allRuns } = progressRuns(runs, contextRuns);
  return Arr.join(
    [
      formatAwaitSummary(runs, until, contextRuns),
      ...Arr.map(projectRunCardTree(allRuns), (row) => {
        const status = sanitizeTerminalLine(
          Fn.pipe(
            [row.run.currentTool, runTiming(row.run)],
            Arr.filter(isTextFragment),
            Arr.join(" · "),
          ),
        );
        return `${runTreeBranch(row)}${awaitedIds.has(row.run.id) ? "◎ " : ""}${runStateGlyph(row.run.state)} ${sanitizeTerminalLine(row.run.name)} (${sanitizeTerminalLine(row.run.id)})${status ? ` · ${status}` : ""}`;
      }),
    ],
    "\n",
  );
};

interface SubagentToolRendererState extends Record<string, unknown> {
  piSubagentsAwaitTicker?: (() => void) | undefined;
  piSubagentsAwaitInvalidate?: (() => void) | undefined;
}

export interface SubagentToolRenderContext {
  readonly state: SubagentToolRendererState;
  readonly invalidate: () => void;
}

const stopNothing = (): void => undefined;

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
        Arr.some(details.cards, (run) => run.state === "starting" || run.state === "running")));
  if (shouldAnimate) {
    context.state.piSubagentsAwaitInvalidate = context.invalidate;
    if (!context.state.piSubagentsAwaitTicker) {
      const weakState = new WeakRef(context.state);
      let stopTimer = stopNothing;
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

const DESCENDANTS_OMITTED = "Some descendants are not shown";

const LIVE_CHILD_STATUS: Readonly<Record<SubagentRunCard["state"], CompactStatus>> = {
  starting: "pending",
  running: "running",
  stopping: "running",
  waiting_for_parent: "attention",
  paused: "paused",
  completed: "success",
  failed: "error",
  stopped: "cancelled",
};

/**
 * A wait's run tree as the live calls beneath its collapsed compact row: each run with its state
 * and current tool, descendants marked, in tree order. A run's own problems are the row's issues,
 * so its entry carries none. Elapsed time shows once a run ends, since the row redraws only when
 * the wait reports progress.
 */
export const awaitLiveChildren = (
  cards: ReadonlyArray<SubagentRunCard>,
  awaitedRunIds: ReadonlySet<string>,
): NonNullable<CompactSummary["children"]> => {
  const entries = Arr.map(projectRunCardTree(cards), ({ run }): CompactChild => {
    const ended = run.endedAt !== undefined && run.startedAt !== undefined;
    return {
      label: sanitizeTerminalLine(run.name),
      status: LIVE_CHILD_STATUS[run.state],
      counters: run.currentTool === undefined ? [] : [sanitizeTerminalLine(run.currentTool)],
      metadata: awaitedRunIds.has(run.id) ? [] : ["descendant"],
      ...(ended && { durationMs: Math.max(0, (run.endedAt ?? 0) - (run.startedAt ?? 0)) }),
    };
  });
  return { entries, total: entries.length, noun: "agent" };
};

/**
 * A wait in progress: the muted totals, then one row per run of the awaited tree with its state,
 * current tool, and timing. Routes and usage per run stay in the settled result's expansion.
 */
export const renderAwaitProgressComponent = (
  cards: ReadonlyArray<SubagentRunCard>,
  until: SubagentAwaitUntil,
  theme: Theme,
  hierarchy: AwaitHierarchy,
  expanded = false,
  heading?: () => AwaitHeading,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const frame = spinnerFrameAt(synchronousNow());
    const counters = formatAwaitCounters(cards, hierarchy, until, { heading: heading?.() });
    return [
      ...(counters
        ? factRowLines([[counters, "muted"]], safeWidth, theme, expanded, { wholeFacts: true })
        : []),
      ...(hierarchy.contextOmitted
        ? [clipToWidth(theme.fg("dim", DESCENDANTS_OMITTED), safeWidth)]
        : []),
      ...Arr.flatMap(projectRunCardTree(cards), (row) => {
        const run = row.run;
        const branch = runTreeBranch(row);
        const glyph = runStateGlyph(run.state, frame);
        const status = Fn.pipe(
          [run.currentTool, runTiming(run)],
          Arr.filter(isTextFragment),
          Arr.map(sanitizeTerminalLine),
          Arr.join(" · "),
        );
        // A wrapped run's facts hang beneath its name.
        return factRowLines(
          [
            [branch, "dim"],
            [glyph, runStateColor(run.state)],
            [" "],
            [sanitizeTerminalLine(run.name), "toolTitle"],
            [status ? ` · ${status}` : "", "muted"],
            [hierarchy.awaitedRunIds.has(run.id) ? "" : " · descendant", "dim"],
          ],
          safeWidth,
          theme,
          expanded,
          { hang: visibleWidth(`${branch}${glyph} `) },
        );
      }),
    ];
  });
