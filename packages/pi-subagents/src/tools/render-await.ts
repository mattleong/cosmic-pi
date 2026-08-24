import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { runStateGlyph, runStateLabel } from "../ui/run-state.ts";
import type { SubagentRunCard, SubagentStartAwaitCardDetails } from "./details.ts";
import { aggregateRunUsage, renderResponsiveRunRows, runTiming } from "./render-run-rows.ts";

interface AwaitProgressRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunCard["state"];
  readonly currentTool?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly endedAt?: number | undefined;
}

const awaitProgressHeader = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
): string => {
  const finished = runs.filter((run) => isAssignmentFinishedRunState(run.state)).length;
  const condition =
    until === "all_finished" ? "Waiting for all subagents" : "Waiting for first subagent";
  const unfinishedStates = [
    "starting",
    "running",
    "waiting_for_parent",
    "paused",
    "stopping",
  ] as const;
  const activeSummary = unfinishedStates
    .flatMap((state) => {
      const count = runs.filter((run) => run.state === state).length;
      return count > 0 ? [`${count} ${runStateLabel(state)}`] : [];
    })
    .join(" · ");
  if (finished === runs.length)
    return `${runs.length} subagent${runs.length === 1 ? "" : "s"} finished`;
  return `${condition} · ${finished} of ${runs.length} subagents finished${activeSummary ? ` · ${activeSummary}` : ""}`;
};

const awaitRunStatus = (run: AwaitProgressRun): string =>
  sanitizeTerminalLine(
    [runStateLabel(run.state), run.currentTool, runTiming(run)].filter(Boolean).join(" · "),
  );

export const formatAwaitProgress = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
): string =>
  [
    awaitProgressHeader(runs, until),
    ...runs.map(
      (run) =>
        `${runStateGlyph(run.state)} ${sanitizeTerminalLine(run.name)} (${sanitizeTerminalLine(run.id)}) · ${awaitRunStatus(run)}`,
    ),
  ].join("\n");

const awaitHeaderColor = (
  runs: ReadonlyArray<SubagentRunCard>,
): "warning" | "success" | "error" => {
  if (runs.some((run) => run.state === "failed")) return "error";
  return runs.length > 0 && runs.every((run) => isAssignmentFinishedRunState(run.state))
    ? "success"
    : "warning";
};

class AwaitProgressComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly until: SubagentAwaitUntil;
  private readonly theme: Theme;

  constructor(runs: ReadonlyArray<SubagentRunCard>, until: SubagentAwaitUntil, theme: Theme) {
    this.runs = runs;
    this.until = until;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frame = Math.floor(synchronousNow() / 160);
    const usage = aggregateRunUsage(this.runs);
    return [
      truncateToWidth(
        this.theme.fg(awaitHeaderColor(this.runs), awaitProgressHeader(this.runs, this.until)),
        safeWidth,
      ),
      ...(usage ? [this.theme.fg("dim", `Total usage · ${usage}`)] : []),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, {
        frame,
        status: awaitRunStatus,
      }),
    ];
  }

  invalidate(): void {
    // Rendering is derived from the current clock frame.
  }
}

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
      const cleanup = () => {
        try {
          stopTimer();
        } catch {
          // Renderer teardown is best effort while the host tool row is settling.
        }
      };
      stopTimer = startTicker(160, () => {
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
  try {
    stop();
  } catch {
    // Renderer teardown is best effort while the host tool row is settling.
  }
};

export const renderAwaitProgressComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  until: SubagentAwaitUntil,
  theme: Theme,
): Component => new AwaitProgressComponent(runs, until, theme);
