import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { synchronousNow } from "../boundary/native-clock.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { isAssignmentFinishedRunState, type SubagentEffort } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { safeTextPrefix } from "../run/state.ts";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../ui/sanitize.ts";
import {
  decodeStartAwaitCardDetails,
  type SubagentRunCard,
  type SubagentStartAwaitCardDetails,
} from "./details.ts";
import { attentionRecoveryText, boundToolOutput, selectionSourceLabel } from "./format.ts";
import type { SubagentStartFailure } from "./subagent.ts";

const awaitProgressHeader = (
  runs: ReadonlyArray<SubagentRunCard>,
  until: SubagentAwaitUntil,
): string => {
  const finished = runs.filter((run) => isAssignmentFinishedRunState(run.state)).length;
  const condition = until === "all_finished" ? "Waiting for all agents" : "Waiting for first agent";
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
    return `${runs.length} agent${runs.length === 1 ? "" : "s"} finished`;
  return `${condition} · ${finished} of ${runs.length} finished${activeSummary ? ` · ${activeSummary}` : ""}`;
};

const awaitRunStatus = (run: SubagentRunCard): string =>
  sanitizeTerminalLine(
    `${runStateLabel(run.state)}${run.currentTool ? ` (${run.currentTool})` : ""}`,
  );

export const formatAwaitProgress = (
  runs: ReadonlyArray<SubagentRunCard>,
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

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;

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
    return [
      truncateToWidth(
        this.theme.fg(awaitHeaderColor(this.runs), awaitProgressHeader(this.runs, this.until)),
        safeWidth,
      ),
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
    details?.cancelled !== true &&
    (details?.action === "start" ||
      (details?.action === "await" &&
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

const effortColor = (
  effort: SubagentEffort,
):
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax" => {
  switch (effort) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
  }
};

interface RunReportSection {
  readonly name: string;
  readonly kind: "report" | "failure";
  readonly text: string;
}

const expandedRunReportSections = (
  runs: ReadonlyArray<SubagentRunCard>,
): ReadonlyArray<RunReportSection> => {
  const candidates = runs.flatMap((run): ReadonlyArray<RunReportSection> => {
    const name = sanitizeTerminalLine(run.name);
    const marker = "\n… [content truncated; use subagent_status for this run]";
    const sections: RunReportSection[] = [];
    if (run.finalText)
      sections.push({
        name,
        kind: "report",
        text: `${sanitizeTerminalText(run.finalText)}${run.finalTextTruncated ? marker : ""}`,
      });
    else if (run.finalTextTruncated)
      sections.push({
        name,
        kind: "report",
        text: "Report content was omitted from this persisted card; use subagent_status for this run.",
      });
    if (run.error)
      sections.push({
        name,
        kind: "failure",
        text: `${sanitizeTerminalText(run.error)}${run.errorTruncated ? marker : ""}`,
      });
    else if (run.errorTruncated)
      sections.push({
        name,
        kind: "failure",
        text: "Failure detail was omitted from this persisted card; use subagent_status for this run.",
      });
    return sections;
  });
  if (candidates.length === 0) return [];
  const headingBudget = candidates.reduce((total, section) => total + section.name.length + 24, 0);
  const perSection = Math.max(
    256,
    Math.floor((MAX_TOOL_OUTPUT_CHARS - headingBudget) / candidates.length),
  );
  return candidates.map((section) => {
    if (section.text.length <= perSection) return section;
    const marker = "\n… [report truncated]";
    return {
      ...section,
      text: `${safeTextPrefix(section.text, perSection - marker.length)}${marker}`,
    };
  });
};

const reportAffordance = (
  sections: ReadonlyArray<RunReportSection>,
  expanded: boolean,
  theme: Theme,
): string => {
  const reportCount = sections.filter((section) => section.kind === "report").length;
  const failureCount = sections.length - reportCount;
  const label =
    failureCount === 0
      ? `final report${reportCount === 1 ? "" : "s"}`
      : reportCount === 0
        ? `failure detail${failureCount === 1 ? "" : "s"}`
        : "reports and failures";
  return theme.fg("dim", `${expanded ? "▾" : "▸"} ${label}${expanded ? "" : " · expand to view"}`);
};

const renderStartFailures = (
  failures: ReadonlyArray<SubagentStartFailure>,
  expanded: boolean,
  theme: Theme,
): string =>
  failures
    .map((failure) => {
      const name = sanitizeTerminalLine(failure.name ?? `start #${failure.index + 1}`);
      const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
      const summary = `${theme.fg("error", `× ${name}`)} · ${theme.fg("error", `failed to start${code}`)}`;
      const raw = sanitizeTerminalLine(failure.message);
      const maximum = expanded ? 2_048 : 240;
      const marker = "… [truncated]";
      const detail =
        raw.length <= maximum
          ? raw
          : `${safeTextPrefix(raw, Math.max(0, maximum - marker.length))}${marker}`;
      return `${summary}\n${theme.fg("dim", detail)}`;
    })
    .join("\n");

class StartProgressComponent implements Component {
  private readonly progress: string;
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly failures: ReadonlyArray<SubagentStartFailure>;
  private readonly theme: Theme;

  constructor(
    progress: string,
    runs: ReadonlyArray<SubagentRunCard>,
    failures: ReadonlyArray<SubagentStartFailure>,
    theme: Theme,
  ) {
    this.progress = progress;
    this.runs = runs;
    this.failures = failures;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frame = Math.floor(synchronousNow() / 160);
    return [
      truncateToWidth(
        this.theme.fg("warning", `${animatedRunStateGlyph("starting", frame)} ${this.progress}`),
        safeWidth,
      ),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, { frame }),
      ...renderStartFailures(this.failures, false, this.theme)
        .split("\n")
        .filter(Boolean)
        .map((line) => truncateToWidth(line, safeWidth)),
    ];
  }

  invalidate(): void {
    // Rendering is derived from the current clock frame.
  }
}

export interface OutcomeBanner {
  readonly color: "warning" | "success" | "error" | "accent";
  readonly text: string;
}

interface ResponsiveRunRowOptions {
  readonly frame?: number;
  readonly status?: (run: SubagentRunCard) => string;
}

const renderResponsiveRunRows = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  options: ResponsiveRunRowOptions = {},
): string[] => {
  const safeWidth = Math.max(1, width);
  const names = runs.map((run) => {
    const glyph =
      options.frame === undefined
        ? runStateGlyph(run.state)
        : animatedRunStateGlyph(run.state, options.frame);
    return `${glyph} ${sanitizeTerminalLine(run.name)}`;
  });
  const efforts = runs.map((run) => sanitizeTerminalLine(run.effort));
  const states = runs.map((run) =>
    sanitizeTerminalLine(options.status?.(run) ?? runStateLabel(run.state)),
  );
  const nameWidth = names.reduce((max, name) => Math.max(max, visibleWidth(name)), 0);
  const effortWidth = efforts.reduce((max, effort) => Math.max(max, visibleWidth(effort)), 0);
  const stateWidth = states.reduce((max, state) => Math.max(max, visibleWidth(state)), 0);
  const modelWidth = safeWidth - nameWidth - effortWidth - stateWidth - 9;
  if (safeWidth >= 64 && modelWidth >= 8)
    return runs.map((run, index) => {
      const name = theme.fg(runStateColor(run.state), names[index] ?? "");
      const model = truncateToWidth(
        sanitizeTerminalLine(`${run.profile ? `[${run.profile}] ` : ""}${run.model}`),
        modelWidth,
      );
      const effort = efforts[index] ?? "";
      const state = theme.fg(runStateColor(run.state), states[index] ?? "");
      return `${padVisible(name, nameWidth)} · ${padVisible(theme.fg("toolOutput", model), modelWidth)} · ${padVisible(theme.fg(effortColor(run.effort), effort), effortWidth)} · ${padVisible(state, stateWidth)}`;
    });
  return runs.flatMap((run, index) => {
    const color = runStateColor(run.state);
    const name = theme.fg(color, names[index] ?? "");
    const state = theme.fg(color, states[index] ?? "");
    const effort = efforts[index] ?? "";
    const modelWidth = Math.max(1, safeWidth - visibleWidth(effort) - 3);
    const model = theme.fg(
      "toolOutput",
      truncateToWidth(
        sanitizeTerminalLine(`${run.profile ? `[${run.profile}] ` : ""}${run.model}`),
        modelWidth,
      ),
    );
    return [
      truncateToWidth(name, safeWidth),
      truncateToWidth(`${model} · ${theme.fg(effortColor(run.effort), effort)}`, safeWidth),
      truncateToWidth(state, safeWidth),
    ];
  });
};

class RunOverviewComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly failures: ReadonlyArray<SubagentStartFailure>;
  private readonly expanded: boolean;
  private readonly theme: Theme;
  private readonly reportSections: ReadonlyArray<RunReportSection>;
  private readonly banner: OutcomeBanner | undefined;

  constructor(
    runs: ReadonlyArray<SubagentRunCard>,
    failures: ReadonlyArray<SubagentStartFailure>,
    expanded: boolean,
    theme: Theme,
    reportSections: ReadonlyArray<RunReportSection>,
    banner?: OutcomeBanner,
  ) {
    this.runs = runs;
    this.failures = failures;
    this.expanded = expanded;
    this.theme = theme;
    this.reportSections = reportSections;
    this.banner = banner;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      ...(this.banner
        ? [truncateToWidth(this.theme.fg(this.banner.color, this.banner.text), safeWidth)]
        : []),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme),
      ...(this.expanded
        ? this.runs.flatMap((run) => {
            const profile = run.profile ? `${sanitizeTerminalLine(run.profile)} · ` : "";
            const summary = sanitizeTerminalLine(
              `${profile}${selectionSourceLabel(run)} · ${run.selection.reason}`,
            );
            return [
              truncateToWidth(this.theme.fg("dim", summary), safeWidth),
              ...run.selection.skippedCandidates.map((candidate) =>
                truncateToWidth(
                  this.theme.fg(
                    "dim",
                    sanitizeTerminalLine(
                      `  skipped ${candidate.candidate} [${candidate.code}] · ${candidate.reason}`,
                    ),
                  ),
                  safeWidth,
                ),
              ),
              ...(run.selection.warning
                ? [
                    truncateToWidth(
                      this.theme.fg("warning", sanitizeTerminalLine(`  ${run.selection.warning}`)),
                      safeWidth,
                    ),
                  ]
                : []),
            ];
          })
        : []),
      ...renderStartFailures(this.failures, this.expanded, this.theme)
        .split("\n")
        .filter(Boolean)
        .map((line) => truncateToWidth(line, safeWidth)),
      ...this.runs
        .filter((run) => run.state === "completed" && !run.finalText && !run.error)
        .map((run) =>
          truncateToWidth(
            this.theme.fg(
              "dim",
              `${sanitizeTerminalLine(run.name)} completed without a final report.`,
            ),
            safeWidth,
          ),
        ),
      ...this.runs
        .filter((run) => run.state === "reported" && run.closeOnReport === false)
        .map((run) =>
          truncateToWidth(
            this.theme.fg(
              "dim",
              `${sanitizeTerminalLine(run.name)} is retained · use subagent_send for its next assignment.`,
            ),
            safeWidth,
          ),
        ),
      ...attentionRecoveryText(this.runs)
        .split("\n")
        .filter(Boolean)
        .map((line) => truncateToWidth(this.theme.fg("warning", line), safeWidth)),
      ...(this.reportSections.length > 0
        ? [
            truncateToWidth(
              reportAffordance(this.reportSections, this.expanded, this.theme),
              safeWidth,
            ),
          ]
        : this.failures.length > 0 && !this.expanded
          ? [this.theme.fg("dim", "▸ failure details · expand to view")]
          : []),
    ];
  }

  invalidate(): void {
    // Rendering is a pure projection of immutable result details.
  }
}

/** Partial await rendering: the animated in-progress fleet card. */
export const renderAwaitProgressComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  until: SubagentAwaitUntil,
  theme: Theme,
): Component => new AwaitProgressComponent(runs, until, theme);

/** Collapsed start/await rendering: run summaries, launch failures, and the report affordance. */
export const renderStartAwaitOverviewComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: OutcomeBanner,
): Component =>
  new RunOverviewComponent(runs, failures, false, theme, expandedRunReportSections(runs), banner);

export const renderExpandedStartAwaitResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: OutcomeBanner,
): Component => {
  const container = new Container();
  const sections = expandedRunReportSections(runs);
  container.addChild(new RunOverviewComponent(runs, failures, true, theme, sections, banner));
  if (sections.length === 0) return container;
  for (const section of sections) {
    container.addChild(new Spacer(1));
    const heading = section.kind === "report" ? "Final report" : "Failure";
    container.addChild(
      new Text(
        theme.fg(section.kind === "report" ? "accent" : "error", `${heading} — ${section.name}`),
        0,
        0,
      ),
    );
    if (section.kind === "report")
      container.addChild(
        new Markdown(section.text, 2, 0, getMarkdownTheme(), {
          color: (text) => theme.fg("toolOutput", text),
        }),
      );
    else container.addChild(new Text(theme.fg("error", section.text), 2, 0));
  }
  return container;
};

export const awaitResultBanner = (details: {
  readonly action?: "start" | "await" | undefined;
  readonly runs?: ReadonlyArray<SubagentRunCard> | undefined;
  readonly awaitUntil?: SubagentAwaitUntil | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
}): OutcomeBanner | undefined => {
  const runs = details.runs ?? [];
  const unfinished = runs.filter((run) => !isAssignmentFinishedRunState(run.state));
  const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
  const attention = waiting > 0 ? ` · parent reply required for ${waiting}` : "";
  if (details.cancelled)
    return {
      color: "warning",
      text:
        runs.length === 0
          ? "Await cancelled"
          : `Await cancelled · ${unfinished.length} unfinished${attention}`,
    };
  if (details.timedOut)
    return {
      color: "warning",
      text: `Await timed out · ${unfinished.length} unfinished${attention}`,
    };
  if (details.attentionRequired)
    return {
      color: "warning",
      text: `Parent reply required for ${waiting} agent${waiting === 1 ? "" : "s"}`,
    };
  if (details.awaitUntil !== "any_finished") return undefined;
  const first = runs
    .filter((run) => isAssignmentFinishedRunState(run.state))
    .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity))[0];
  if (!first) return undefined;
  const name = sanitizeTerminalLine(first.name);
  const outcome =
    first.state === "reported"
      ? "reported first · backend retained"
      : `${runStateLabel(first.state)} first`;
  return {
    color: first.state === "failed" ? "error" : "accent",
    text: `${name} ${outcome}${unfinished.length > 0 ? ` · ${unfinished.length} unfinished` : ""}${attention}`,
  };
};

const includeContentOmission = (
  banner: OutcomeBanner | undefined,
  omitted: boolean | undefined,
): OutcomeBanner | undefined => {
  if (!omitted) return banner;
  const warning =
    "Some report content was omitted from the persisted card; use subagent_status for individual runs";
  return banner
    ? { color: "warning", text: `${banner.text} · ${warning}` }
    : { color: "warning", text: warning };
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component => {
  const safeTarget = sanitizeTerminalLine(target);
  const clippedTarget =
    safeTarget.length <= 160 ? safeTarget : `${safeTextPrefix(safeTarget, 146)}… [truncated]`;
  return new Text(
    `${theme.fg("toolTitle", theme.bold(name))}${clippedTarget ? ` ${theme.fg("dim", clippedTarget)}` : ""}`,
    0,
    0,
  );
};

export const renderSubagentResult = (
  result: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly details?: unknown;
  },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
): Component => {
  const details = decodeStartAwaitCardDetails(result.details);
  if (isPartial && details?.action === "await" && details.awaitUntil) {
    if (details.cancelled)
      return new RunOverviewComponent(
        details.cards,
        [],
        false,
        theme,
        [],
        awaitResultBanner({ ...details, runs: details.cards }),
      );
    return renderAwaitProgressComponent(details.cards, details.awaitUntil, theme);
  }
  if (isPartial && details?.action === "start") {
    const rawProgress = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" ");
    const progress = sanitizeTerminalLine(rawProgress || "Starting subagents…");
    return new StartProgressComponent(progress, details.cards, details.startFailures ?? [], theme);
  }
  if (!isPartial && details) {
    const failures = details.startFailures ?? [];
    const banner = includeContentOmission(
      details.action === "await"
        ? awaitResultBanner({ ...details, runs: details.cards })
        : undefined,
      details.contentOmitted,
    );
    if (expanded) {
      const rendered = renderExpandedStartAwaitResult(details.cards, theme, failures, banner);
      if (!details.contentOmitted) return rendered;
      const fallback = boundToolOutput(
        sanitizeTerminalText(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n"),
        ),
      );
      const container = new Container();
      container.addChild(rendered);
      if (fallback) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", theme.bold("Bounded tool output")), 0, 0));
        container.addChild(new Text(theme.fg("toolOutput", fallback), 2, 0));
      }
      return container;
    }
    return renderStartAwaitOverviewComponent(details.cards, theme, failures, banner);
  }
  let text = boundToolOutput(
    sanitizeTerminalText(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n"),
    ),
  );
  if (!expanded) {
    const lines = text.split("\n");
    if (lines.length > 12)
      text = `${lines.slice(0, 11).join("\n")}\n… [${lines.length - 11} more lines · expand to view]`;
  }
  return new Text(
    theme.fg(isPartial ? "warning" : "toolOutput", text || (isPartial ? "Working…" : "Done")),
    0,
    0,
  );
};
