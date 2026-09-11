import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import {
  hasSubagentCapability,
  isActiveRunState,
  type SubagentRunState,
  type SubagentRunView,
  type SubagentSessionEvent,
} from "../run/model.ts";
import { formatDuration, formatRelativeAge, formatUsage } from "./metrics.ts";
import { animatedRunStateGlyph, runStateColor, runStateGlyph, runStateLabel } from "./run-state.ts";

export interface SessionOutputRenderOptions {
  readonly now?: number;
  readonly showTechnicalDetails?: boolean;
  /** Pure presentation hook for the fleet pane; transcript output keeps its own heading. */
  readonly renderHeading?: (sanitizedName: string) => string;
}

type ToolEvent = Extract<SubagentSessionEvent, { readonly type: "tool" }>;
type NoticeEvent = Extract<SubagentSessionEvent, { readonly type: "notice" }>;
/** Progress notices render as the live progress field; they never reach addNotice. */
type VisibleNoticeEvent = Omit<NoticeEvent, "kind"> & {
  readonly kind: "parent" | "question" | "warning";
};
type ActivityItem =
  | { readonly type: "tools"; readonly events: ReadonlyArray<ToolEvent> }
  | { readonly type: "notice"; readonly event: VisibleNoticeEvent };

class HangingText implements Component {
  private readonly prefix: string;
  private readonly text: string;
  private readonly paddingX: number;

  constructor(prefix: string, text: string, paddingX = 2) {
    this.prefix = prefix;
    this.text = text;
    this.paddingX = paddingX;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const padding = Math.min(this.paddingX, Math.max(0, Math.floor((safeWidth - 1) / 2)));
    const contentWidth = Math.max(1, safeWidth - padding * 2);
    const prefix = truncateToWidth(this.prefix, Math.max(0, contentWidth - 1), "");
    const prefixWidth = visibleWidth(prefix);
    const bodyWidth = Math.max(1, contentWidth - prefixWidth);
    const rows = wrapTextWithAnsi(this.text, bodyWidth);
    const margin = " ".repeat(padding);
    const continuation = " ".repeat(prefixWidth);
    return rows.map((row, index) => `${margin}${index === 0 ? prefix : continuation}${row}`);
  }

  invalidate(): void {}
}

const isVisibleNotice = (event: NoticeEvent): event is VisibleNoticeEvent =>
  event.kind !== "progress";

const activityItems = (
  events: ReadonlyArray<SubagentSessionEvent>,
): ReadonlyArray<ActivityItem> => {
  const items: ActivityItem[] = [];
  let openGroup: ToolEvent[] | undefined;
  for (const event of events) {
    if (event.type === "assistant") continue;
    if (event.type === "notice") {
      // Progress notices render as the live progress field instead.
      if (isVisibleNotice(event)) {
        items.push({ type: "notice", event });
        openGroup = undefined;
      }
      continue;
    }
    const last = openGroup?.at(-1);
    if (openGroup && last?.toolName === event.toolName && last.state === event.state) {
      openGroup.push(event);
    } else {
      openGroup = [event];
      items.push({ type: "tools", events: openGroup });
    }
  }
  return items;
};

function addToolGroup(
  container: Container,
  events: ReadonlyArray<ToolEvent>,
  theme: Theme,
  frame: number,
): void {
  const first = events[0];
  if (!first) return;
  const glyph =
    first.state === "running"
      ? animatedRunStateGlyph("running", frame)
      : first.state === "failed"
        ? runStateGlyph("failed")
        : runStateGlyph("completed");
  const color =
    first.state === "running" ? "accent" : first.state === "failed" ? "error" : "success";
  const count = events.length > 1 ? ` ×${events.length}` : "";
  const target =
    events.length === 1 && first.target ? `  ${sanitizeTerminalLine(first.target)}` : "";
  const elapsed = events.reduce(
    (total, event) =>
      total + (event.endedAt === undefined ? 0 : Math.max(0, event.endedAt - event.startedAt)),
    0,
  );
  const elapsedLabel = elapsed > 0 ? formatDuration(elapsed) : "";
  const body = `${theme.fg("toolTitle", sanitizeTerminalLine(first.toolName))}${theme.fg("muted", count)}${theme.fg("dim", target)}${elapsedLabel ? theme.fg("dim", `  ${elapsedLabel}`) : ""}`;
  container.addChild(new HangingText(`${theme.fg(color, glyph)} `, body));
  if (events.length > 1) {
    const targets = [
      ...new Set(
        events.flatMap((event) => (event.target ? [sanitizeTerminalLine(event.target)] : [])),
      ),
    ];
    if (targets.length > 0) {
      const shown = targets.slice(0, 3);
      const remaining = targets.length - shown.length;
      const summary = `${shown.join(" · ")}${remaining > 0 ? ` · +${remaining}` : ""}`;
      container.addChild(new HangingText("  ", theme.fg("dim", summary)));
    }
  }
}

const NOTICE_STYLES = {
  parent: { glyph: "←", color: "muted" },
  question: { glyph: "?", color: "warning" },
  warning: { glyph: "!", color: "warning" },
} as const;

/** Per-state guidance shown when a run has no activity, notices, or live fields at all. */
const EMPTY_ACTIVITY_LABELS = {
  starting: "Starting…",
  running: "Working…",
  waiting_for_parent: "Waiting for parent…",
  reported: "Report delivered; retained backend is idle.",
  stopping: "Stopping…",
  completed: "Completed without tool activity.",
  failed: "No tool activity before failure.",
  stopped: "Stopped.",
} as const satisfies Readonly<Record<Exclude<SubagentRunState, "paused">, string>>;

const emptyActivityLabel = (run: SubagentRunView): string =>
  run.state === "paused"
    ? hasSubagentCapability(run, "resume")
      ? "Paused; resume when ready."
      : "Interrupted; stop this run and start a replacement when needed."
    : EMPTY_ACTIVITY_LABELS[run.state];

/** Live run fields rendered in order, each only when no persisted notice already covers it. */
const addLiveActivity = (
  container: Container,
  run: SubagentRunView,
  theme: Theme,
  now: number,
): void => {
  const items = activityItems(run.sessionEvents);
  const frame = Math.floor(now / 160);
  for (const item of items) {
    if (item.type === "tools") {
      addToolGroup(container, item.events, theme, frame);
      continue;
    }
    const style = NOTICE_STYLES[item.event.kind];
    container.addChild(
      new HangingText(
        `${theme.fg(style.color, style.glyph)} `,
        theme.fg(style.color, sanitizeTerminalLine(item.event.text)),
      ),
    );
  }
  const noticeKinds = new Set(
    items.flatMap((item) => (item.type === "notice" ? [item.event.kind] : [])),
  );
  const liveFields = [
    {
      covered: noticeKinds.has("question"),
      glyph: "?",
      color: "warning",
      text: run.question?.message,
    },
    { covered: noticeKinds.has("warning"), glyph: "!", color: "warning", text: run.warning },
    { covered: false, glyph: "…", color: "muted", text: run.progress },
  ] as const;
  for (const { covered, glyph, color, text } of liveFields) {
    if (covered || text === undefined) continue;
    container.addChild(
      new HangingText(`${theme.fg(color, glyph)} `, theme.fg(color, sanitizeTerminalLine(text))),
    );
  }
  const showedLive =
    items.length > 0 ||
    run.question !== undefined ||
    run.warning !== undefined ||
    run.progress !== undefined;
  if (!showedLive) container.addChild(new Text(theme.fg("dim", emptyActivityLabel(run)), 2, 0));
};

const addAssistantConclusion = (container: Container, run: SubagentRunView, theme: Theme): void => {
  const assistantOutput =
    run.state === "reported" || !isActiveRunState(run.state) ? run.finalText : undefined;
  if (assistantOutput !== undefined && assistantOutput.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg(
          "accent",
          theme.bold(
            run.state === "reported"
              ? `Report generation ${run.reportGeneration} · backend retained`
              : "Final report",
          ),
        ),
        0,
        0,
      ),
    );
    container.addChild(
      new Markdown(sanitizeTerminalText(assistantOutput), 2, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("toolOutput", text),
      }),
    );
  }
  if (run.state === "completed" && !assistantOutput && !run.error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "Completed without a final report."), 0, 0));
  }
  if (run.error) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(theme.fg("error", `Error: ${sanitizeTerminalLine(run.error)}`), 0, 0),
    );
  }
  const usage = formatUsage(run.usage);
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
};

/** One hanging technical-detail row; bodies arrive pre-sanitized where needed. */
const addDetailLine = (
  container: Container,
  prefix: string,
  body: string,
  theme: Theme,
  color: "dim" | "warning" = "dim",
): void => void container.addChild(new HangingText(theme.fg(color, prefix), theme.fg(color, body)));

function addTechnicalDetails(container: Container, run: SubagentRunView, theme: Theme): void {
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Technical details")), 0, 0));
  const process = [
    run.id,
    run.profile ? `profile ${run.profile}` : undefined,
    `${run.host}/${run.runtime}`,
    run.parentRunId ? `parent ${run.parentRunId}` : undefined,
    run.depth !== undefined
      ? `depth ${run.depth} · children ${run.directChildCount ?? 0}/${run.descendantCount ?? 0}`
      : undefined,
    run.nativeActivity
      ? `native ${run.nativeActivity.active} active/${run.nativeActivity.total} total`
      : undefined,
    `closeOnReport=${run.closeOnReport}`,
    run.pid ? `pid ${run.pid}` : undefined,
    `report generation ${run.reportGeneration}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  container.addChild(new Text(theme.fg("dim", sanitizeTerminalLine(process)), 2, 0));
  const candidate =
    run.selection.candidateIndex === undefined
      ? run.selection.source
      : `${run.selection.source} candidate ${run.selection.candidateIndex + 1}`;
  addDetailLine(
    container,
    "selection  ",
    `${candidate} · ${sanitizeTerminalLine(run.selection.reason)}`,
    theme,
  );
  for (const skipped of run.selection.skippedCandidates) {
    addDetailLine(
      container,
      "skipped  ",
      `${sanitizeTerminalLine(skipped.candidate)} [${sanitizeTerminalLine(skipped.code)}] · ${sanitizeTerminalLine(skipped.reason)}`,
      theme,
    );
  }
  if (run.selection.warning) {
    addDetailLine(
      container,
      "route warning  ",
      sanitizeTerminalLine(run.selection.warning),
      theme,
      "warning",
    );
  }
  addDetailLine(container, "cwd  ", sanitizeTerminalLine(run.cwd), theme);
  if (run.sessionId)
    addDetailLine(container, "session id  ", sanitizeTerminalLine(run.sessionId), theme);
  if (run.sessionFile)
    addDetailLine(container, "session  ", sanitizeTerminalLine(run.sessionFile), theme);
}

export function renderSubagentSessionOutput(
  run: SubagentRunView,
  theme: Theme,
  options: SessionOutputRenderOptions = {},
): Component {
  const now = options.now ?? run.lastActivityAt;
  const container = new Container();
  const name = sanitizeTerminalLine(run.name);
  const active = isActiveRunState(run.state);
  const end =
    run.endedAt ??
    (run.state === "paused" ? run.lastActivityAt : active ? now : run.lastActivityAt);
  const elapsed = formatDuration(end - run.startedAt);
  const duration =
    run.state === "paused"
      ? `paused after ${elapsed}`
      : run.state === "reported"
        ? `idle after report ${run.reportGeneration}`
        : run.state === "waiting_for_parent"
          ? `waiting · ${elapsed}`
          : active
            ? `running for ${elapsed}`
            : elapsed;
  const age =
    run.state === "completed" || run.state === "reported"
      ? ` ${formatRelativeAge(now - (run.endedAt ?? run.lastActivityAt))}`
      : "";
  const subtitle = sanitizeTerminalLine(
    `${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""} · ${run.profile ? `${run.profile} · ` : ""}${run.context} · ${run.model}:${run.effort} · ${duration}`,
  );
  container.addChild(
    new Text(
      `${options.renderHeading ? options.renderHeading(name) : theme.fg("toolTitle", theme.bold(name))}  ${theme.fg(runStateColor(run.state), `${runStateGlyph(run.state)} ${runStateLabel(run.state)}${age}`)}`,
      0,
      0,
    ),
  );
  container.addChild(new Text(theme.fg("dim", subtitle), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Task")), 0, 0));
  container.addChild(
    new Markdown(sanitizeTerminalText(run.task), 2, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("toolOutput", text),
    }),
  );
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Activity")), 0, 0));
  addLiveActivity(container, run, theme, now);
  addAssistantConclusion(container, run, theme);
  if (options.showTechnicalDetails) addTechnicalDetails(container, run, theme);
  return container;
}
