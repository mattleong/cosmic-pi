import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
  formatDuration,
  formatElapsed,
  formatRelativeAge,
} from "pi-cosmic-core";
import { listDetailHeading } from "pi-cosmic-ui/manager/list-detail-shell";
import { managerTone } from "pi-cosmic-ui/manager/style";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import {
  hasSubagentCapability,
  isActiveRunState,
  isAssignmentFinishedRunState,
  type SubagentRunState,
  type SubagentRunView,
  type SubagentSessionEvent,
} from "../run/model.ts";
import { steeringDeliveryEvidence } from "../tools/outcome.ts";
import { aggregateUsage } from "./metrics.ts";
import { runStateColor, runStateGlyph, runStateLabel } from "./run-state.ts";
import {
  clipToWidth,
  managerActivityLabel,
  managerNoticeGlyph,
  spinnerFrameAt,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";

interface SessionOutputRenderOptions {
  readonly now?: number;
  readonly showTechnicalDetails?: boolean;
  /** Whether the fleet detail pane owns focus; it accents the heading. */
  readonly detailFocused?: boolean;
}

type ToolEvent = Extract<SubagentSessionEvent, { readonly type: "tool" }>;
type NoticeEvent = Extract<SubagentSessionEvent, { readonly type: "notice" }>;
type ActivityItem =
  | { readonly type: "tools"; readonly events: ReadonlyArray<ToolEvent> }
  | { readonly type: "notice"; readonly event: NoticeEvent };

const HANGING_PADDING = 2;

/** Padded text whose wrapped rows hang under the first row's body, past its prefix. */
const hangingText = (prefix: string, text: string): Component =>
  composeToolComponent((width) => {
    const safeWidth = Math.max(1, width);
    const padding = Math.min(HANGING_PADDING, Math.max(0, Math.floor((safeWidth - 1) / 2)));
    const contentWidth = Math.max(1, safeWidth - padding * 2);
    const shownPrefix = clipToWidth(prefix, Math.max(0, contentWidth - 1), "");
    const prefixWidth = visibleWidth(shownPrefix);
    const rows = wrapTextWithAnsi(text, Math.max(1, contentWidth - prefixWidth));
    const margin = " ".repeat(padding);
    const continuation = " ".repeat(prefixWidth);
    return rows.map((row, index) => `${margin}${index === 0 ? shownPrefix : continuation}${row}`);
  });

/** A titled or standalone block, a blank line below what precedes it. */
const addBlock = (container: Container, text: string): void => {
  container.addChild(new Spacer(1));
  container.addChild(new Text(text, 0, 0));
};

const markdownBlock = (text: string, theme: Theme): Markdown =>
  new Markdown(sanitizeTerminalText(text), 2, 0, getMarkdownTheme(), {
    color: (line) => theme.fg("toolOutput", line),
  });

const activityItems = (
  events: ReadonlyArray<SubagentSessionEvent>,
): ReadonlyArray<ActivityItem> => {
  const items: ActivityItem[] = [];
  let openGroup: ToolEvent[] | undefined;
  for (const event of events) {
    if (event.type === "assistant") continue;
    if (event.type === "notice") {
      // Progress notices render as the live progress field instead.
      if (event.kind !== "progress") {
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
  // A tool's state is also a run state, so it takes that state's glyph and color.
  const glyph = theme.fg(runStateColor(first.state), runStateGlyph(first.state, frame));
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
  container.addChild(hangingText(`${glyph} `, body));
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
      container.addChild(hangingText("  ", theme.fg("dim", summary)));
    }
  }
}

const NOTICE_STYLES = {
  parent: { glyph: "←", color: "muted" },
  question: { glyph: managerNoticeGlyph("warning"), color: "warning" },
  warning: { glyph: managerNoticeGlyph("warning"), color: "warning" },
  progress: { glyph: "…", color: "muted" },
} as const;

const addStyledRow = (
  container: Container,
  style: { readonly glyph: string; readonly color: "muted" | "warning" | "success" },
  text: string,
  theme: Theme,
): void =>
  void container.addChild(
    hangingText(
      `${theme.fg(style.color, style.glyph)} `,
      theme.fg(style.color, sanitizeTerminalLine(text)),
    ),
  );

/**
 * Native guidance delivery only, from the shared tool evidence. Confirmation is never shown as
 * incorporation, and every other state keeps attention because the input may already have arrived.
 */
const addSteeringDelivery = (container: Container, run: SubagentRunView, theme: Theme): void => {
  if (run.steeringDelivery === undefined) return;
  const style =
    run.steeringDelivery === "confirmed"
      ? ({ glyph: runStateGlyph("completed"), color: "success" } as const)
      : NOTICE_STYLES.warning;
  addStyledRow(container, style, steeringDeliveryEvidence[run.steeringDelivery].message, theme);
};

/** A live state in the word every extension uses for it: "Starting…", "Running…". */
const liveLabel = (kind: ManagerActivityKind): string => {
  const word = managerActivityLabel(kind);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}…`;
};

/** Per-state guidance shown when a run has no activity, notices, or live fields at all. */
const EMPTY_ACTIVITY_LABELS = {
  starting: liveLabel("pending"),
  running: liveLabel("running"),
  waiting_for_parent: "Waiting for parent…",
  reported: "Report delivered; retained backend is idle.",
  stopping: liveLabel("stopping"),
  completed: "Finished without tool activity.",
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
  const frame = spinnerFrameAt(now);
  for (const item of items) {
    if (item.type === "tools") addToolGroup(container, item.events, theme, frame);
    else addStyledRow(container, NOTICE_STYLES[item.event.kind], item.event.text, theme);
  }
  const noticeKinds = new Set(
    items.flatMap((item) => (item.type === "notice" ? [item.event.kind] : [])),
  );
  const liveFields = [
    [noticeKinds.has("question"), NOTICE_STYLES.question, run.question?.message],
    [noticeKinds.has("warning"), NOTICE_STYLES.warning, run.warning],
    [false, NOTICE_STYLES.progress, run.progress],
  ] as const;
  for (const [covered, style, text] of liveFields) {
    if (!covered && text !== undefined) addStyledRow(container, style, text, theme);
  }
  if (items.length === 0 && liveFields.every(([, , text]) => text === undefined))
    container.addChild(new Text(theme.fg("dim", emptyActivityLabel(run)), 2, 0));
};

/** What a completed run without a report says about it; an available one isn't observed here. */
const MISSING_REPORT_STATUS = {
  available: "Final report availability unknown in this observation.",
  missing: "No accepted final report for this assignment.",
  claimed: "Final report claimed by another operation.",
  delivered: "Final report already delivered.",
} satisfies Readonly<Record<NonNullable<SubagentRunView["reportStatus"]>, string>>;

const addAssistantConclusion = (container: Container, run: SubagentRunView, theme: Theme): void => {
  const output = isAssignmentFinishedRunState(run.state) ? run.finalText : undefined;
  if (output) {
    addBlock(container, theme.fg("accent", theme.bold("Final report")));
    container.addChild(markdownBlock(output, theme));
  }
  if (run.state === "completed" && !output && !run.error)
    addBlock(container, theme.fg("dim", MISSING_REPORT_STATUS[run.reportStatus ?? "available"]));
  if (run.error)
    addBlock(container, theme.fg("error", `Error: ${sanitizeTerminalLine(run.error)}`));
  const usage = aggregateUsage([run]);
  if (usage) addBlock(container, theme.fg("dim", usage));
};

/** One hanging technical-detail row; bodies arrive pre-sanitized where needed. */
const addDetailLine = (
  container: Container,
  prefix: string,
  body: string,
  theme: Theme,
  color: "dim" | "warning" = "dim",
): void => void container.addChild(hangingText(theme.fg(color, prefix), theme.fg(color, body)));

function addTechnicalDetails(container: Container, run: SubagentRunView, theme: Theme): void {
  addBlock(container, theme.fg("muted", theme.bold("Technical details")));
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
  // A paused run's clock stops at its last activity.
  const end = run.endedAt ?? (active && run.state !== "paused" ? now : run.lastActivityAt);
  const elapsed = formatElapsed(end - run.startedAt);
  const duration =
    run.state === "paused"
      ? `${runStateLabel(run.state)} after ${elapsed}`
      : run.state === "waiting_for_parent"
        ? `waiting · ${elapsed}`
        : active
          ? `running for ${elapsed}`
          : elapsed;
  const age =
    run.state === "completed"
      ? ` ${formatRelativeAge(now - (run.endedAt ?? run.lastActivityAt))}`
      : "";
  const heading = listDetailHeading(
    theme,
    name,
    options.detailFocused === true,
    managerTone.identity,
  );
  const profile = sanitizeTerminalLine(run.profile ?? "");
  const subtitle = [
    theme.fg(
      "muted",
      sanitizeTerminalLine(`${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""}`),
    ),
    ...(profile ? [theme.fg(managerTone.identity, profile)] : []),
    theme.fg(managerTone.value, sanitizeTerminalLine(run.context)),
    theme.fg(managerTone.value, sanitizeTerminalLine(`${run.model}:${run.effort}`)),
    theme.fg("muted", sanitizeTerminalLine(duration)),
  ].join(" · ");
  container.addChild(
    new Text(
      `${heading}  ${theme.fg(runStateColor(run.state), `${runStateGlyph(run.state)} ${runStateLabel(run.state)}${age}`)}`,
      0,
      0,
    ),
  );
  container.addChild(new Text(subtitle, 0, 0));
  addBlock(container, theme.fg("muted", theme.bold("Task")));
  container.addChild(markdownBlock(run.task, theme));
  addBlock(container, theme.fg("muted", theme.bold("Activity")));
  addSteeringDelivery(container, run, theme);
  addLiveActivity(container, run, theme, now);
  addAssistantConclusion(container, run, theme);
  if (options.showTechnicalDetails) addTechnicalDetails(container, run, theme);
  return container;
}
