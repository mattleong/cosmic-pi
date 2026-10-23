import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
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
  isTerminalRunState,
  type SubagentRunState,
  type SubagentRunView,
  type SubagentSessionEvent,
} from "../run/model.ts";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { steeringDeliveryEvidence } from "../tools/outcome.ts";
import { cleanupEvidenceText, cleanupRecoveryText } from "../tools/format.ts";
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
  readonly detailFocused?: boolean;
}

type ToolEvent = Extract<SubagentSessionEvent, { readonly type: "tool" }>;
type NoticeEvent = Extract<SubagentSessionEvent, { readonly type: "notice" }>;
type AssistantEvent = Extract<SubagentSessionEvent, { readonly type: "assistant" }>;
type ActivityItem =
  | { readonly type: "tools"; readonly events: ReadonlyArray<ToolEvent> }
  | { readonly type: "notice"; readonly event: NoticeEvent }
  | { readonly type: "assistant"; readonly event: AssistantEvent };

// The live view shows the start of each message; the final report appears in full below it.
const MAX_LIVE_ASSISTANT_CHARS = 1_200;

const HANGING_PADDING = 2;

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
  finalText: string | undefined,
): ReadonlyArray<ActivityItem> => {
  const items: ActivityItem[] = [];
  let openGroup: ToolEvent[] | undefined;
  for (const event of events) {
    if (event.type === "assistant") {
      if (event.text !== finalText?.trim()) items.push({ type: "assistant", event });
      openGroup = undefined;
      continue;
    }
    if (event.type === "notice") {
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
  if (events.length === 1 && first.outputPreview)
    container.addChild(
      hangingText("  ", theme.fg("dim", sanitizeTerminalText(first.outputPreview))),
    );
  if (events.length > 1) {
    const targets = [
      ...new Set(
        Arr.filterMap(events, (event) =>
          event.target ? Result.succeed(sanitizeTerminalLine(event.target)) : Result.failVoid,
        ),
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
  message: { glyph: "✉", color: "muted" },
} as const;

const noticeText = (event: NoticeEvent): string =>
  event.kind === "message"
    ? `${event.direction === "in" ? "From" : "To"} ${event.peer}: ${event.text}`
    : event.text;

const addStyledRow = (
  container: Container,
  style: { readonly glyph: string; readonly color: "muted" | "warning" | "success" },
  text: string,
  theme: Theme,
): void => {
  container.addChild(
    hangingText(
      `${theme.fg(style.color, style.glyph)} `,
      theme.fg(style.color, sanitizeTerminalLine(text)),
    ),
  );
};

const addSteeringDelivery = (container: Container, run: SubagentRunView, theme: Theme): void => {
  if (run.steeringDelivery === undefined) return;
  const style =
    run.steeringDelivery === "confirmed"
      ? ({ glyph: runStateGlyph("completed"), color: "success" } as const)
      : NOTICE_STYLES.warning;
  addStyledRow(container, style, steeringDeliveryEvidence[run.steeringDelivery].message, theme);
};

const liveLabel = (kind: ManagerActivityKind): string => {
  const word = managerActivityLabel(kind);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}…`;
};

const EMPTY_ACTIVITY_LABELS = {
  starting: liveLabel("pending"),
  running: liveLabel("running"),
  waiting_for_parent: "Waiting for parent…",
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

const addAssistantMessage = (container: Container, text: string, theme: Theme): void => {
  const shown =
    text.length > MAX_LIVE_ASSISTANT_CHARS ? `${text.slice(0, MAX_LIVE_ASSISTANT_CHARS)}…` : text;
  container.addChild(markdownBlock(shown, theme));
};

const addLiveActivity = (
  container: Container,
  run: SubagentRunView,
  theme: Theme,
  now: number,
): void => {
  const items = activityItems(
    run.sessionEvents,
    isTerminalRunState(run.state) ? run.finalText : undefined,
  );
  const frame = spinnerFrameAt(now);
  for (const item of items) {
    if (item.type === "tools") addToolGroup(container, item.events, theme, frame);
    else if (item.type === "assistant") addAssistantMessage(container, item.event.text, theme);
    else addStyledRow(container, NOTICE_STYLES[item.event.kind], noticeText(item.event), theme);
  }
  const noticeKinds = new Set(
    Arr.filterMap(items, (item) =>
      item.type === "notice" ? Result.succeed(item.event.kind) : Result.failVoid,
    ),
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

const MISSING_REPORT_STATUS = {
  available: "Final report availability unknown in this observation.",
  missing: "No accepted final report for this assignment.",
  claimed: "Final report claimed by another operation.",
  delivered: "Final report already delivered.",
} satisfies Readonly<Record<NonNullable<SubagentRunView["reportStatus"]>, string>>;

const addAssistantConclusion = (container: Container, run: SubagentRunView, theme: Theme): void => {
  const output = isTerminalRunState(run.state) ? run.finalText : undefined;
  if (output) {
    addBlock(container, theme.fg("accent", theme.bold("Final report")));
    container.addChild(markdownBlock(output, theme));
  }
  if (run.state === "completed" && !output && !run.error)
    addBlock(container, theme.fg("dim", MISSING_REPORT_STATUS[run.reportStatus ?? "available"]));
  if (run.error)
    addBlock(container, theme.fg("error", `Error: ${sanitizeTerminalLine(run.error)}`));
  const usage = aggregateUsage([run]);
  const context =
    run.usage.contextPercent === undefined
      ? undefined
      : `context ${Math.round(run.usage.contextPercent)}% full`;
  const usageLine = [usage, context].filter(Boolean).join(" · ");
  if (usageLine)
    addBlock(
      container,
      theme.fg((run.usage.contextPercent ?? 0) >= 80 ? "warning" : "dim", usageLine),
    );
};

const addDetailLine = (
  container: Container,
  prefix: string,
  body: string,
  theme: Theme,
  color: "dim" | "warning" = "dim",
): void => {
  container.addChild(hangingText(theme.fg(color, prefix), theme.fg(color, body)));
};

function addTechnicalDetails(container: Container, run: SubagentRunView, theme: Theme): void {
  addBlock(container, theme.fg("muted", theme.bold("Technical details")));
  const process = [
    run.id,
    run.profile ? `profile ${run.profile}` : undefined,
    `local/${run.runtime}`,
    run.parentRunId ? `parent ${run.parentRunId}` : undefined,
    run.depth !== undefined
      ? `depth ${run.depth} · children ${run.directChildCount ?? 0}/${run.descendantCount ?? 0}`
      : undefined,
    run.nativeActivity
      ? `native ${run.nativeActivity.active} active/${run.nativeActivity.total} total`
      : undefined,
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
      `${sanitizeTerminalLine(skippedCandidateLabel(skipped.candidate))} [${sanitizeTerminalLine(skipped.code)}] · ${sanitizeTerminalLine(skipped.reason)}`,
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
  const cleanup = cleanupRecoveryText(run).join("\n") || cleanupEvidenceText(run);
  if (cleanup)
    addBlock(
      container,
      theme.fg(
        run.cleanup?.disposition === "confirmed" && !run.writerCleanupQuarantined
          ? "dim"
          : "warning",
        sanitizeTerminalText(cleanup),
      ),
    );
  addLiveActivity(container, run, theme, now);
  addAssistantConclusion(container, run, theme);
  if (options.showTechnicalDetails) addTechnicalDetails(container, run, theme);
  return container;
}
