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
  type SubagentRunView,
  type SubagentSessionEvent,
} from "../run/model.ts";
import { formatDuration, formatUsage } from "./metrics.ts";
import { animatedRunStateGlyph, runStateColor, runStateGlyph, runStateLabel } from "./run-state.ts";

export interface SessionOutputRenderOptions {
  readonly now?: number;
  readonly showTechnicalDetails?: boolean;
}

type ToolEvent = Extract<SubagentSessionEvent, { readonly type: "tool" }>;
type NoticeEvent = Extract<SubagentSessionEvent, { readonly type: "notice" }>;
type ActivityItem =
  | { readonly type: "tools"; readonly events: ReadonlyArray<ToolEvent> }
  | { readonly type: "notice"; readonly event: NoticeEvent };

export const formatRelativeAge = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

const runDuration = (run: SubagentRunView, now: number): string => {
  const active = isActiveRunState(run.state);
  const end =
    run.endedAt ??
    (run.state === "paused" ? run.lastActivityAt : active ? now : run.lastActivityAt);
  const elapsed = formatDuration(end - run.startedAt);
  if (run.state === "paused") return `paused after ${elapsed}`;
  if (run.state === "reported") return `idle after report ${run.reportGeneration}`;
  if (run.state === "waiting_for_parent") return `waiting · ${elapsed}`;
  return active ? `running for ${elapsed}` : elapsed;
};

const stateLabel = (run: SubagentRunView, theme: Theme, now: number): string => {
  const age =
    run.state === "completed" || run.state === "reported"
      ? ` ${formatRelativeAge(now - (run.endedAt ?? run.lastActivityAt))}`
      : "";
  return theme.fg(
    runStateColor(run.state),
    `${runStateGlyph(run.state)} ${runStateLabel(run.state)}${age}`,
  );
};

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

const activityItems = (
  events: ReadonlyArray<SubagentSessionEvent>,
): ReadonlyArray<ActivityItem> => {
  const items: ActivityItem[] = [];
  let openGroup: ToolEvent[] | undefined;
  for (const event of events) {
    if (event.type === "assistant" || (event.type === "notice" && event.kind === "progress"))
      continue;
    if (event.type === "notice") {
      items.push({ type: "notice", event });
      openGroup = undefined;
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

const toolDuration = (events: ReadonlyArray<ToolEvent>): string => {
  const elapsed = events.reduce(
    (total, event) =>
      total + (event.endedAt === undefined ? 0 : Math.max(0, event.endedAt - event.startedAt)),
    0,
  );
  return elapsed > 0 ? formatDuration(elapsed) : "";
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
  const elapsed = toolDuration(events);
  const body = `${theme.fg("toolTitle", sanitizeTerminalLine(first.toolName))}${theme.fg("muted", count)}${theme.fg("dim", target)}${elapsed ? theme.fg("dim", `  ${elapsed}`) : ""}`;
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

function addNotice(container: Container, event: NoticeEvent, theme: Theme): void {
  const glyph = event.kind === "parent" ? "←" : event.kind === "question" ? "?" : "!";
  const color =
    event.kind === "parent"
      ? "muted"
      : event.kind === "question" || event.kind === "warning"
        ? "warning"
        : "error";
  container.addChild(
    new HangingText(
      `${theme.fg(color, glyph)} `,
      theme.fg(color, sanitizeTerminalLine(event.text)),
    ),
  );
}

const emptyActivityLabel = (run: SubagentRunView): string => {
  switch (run.state) {
    case "starting":
      return "Starting…";
    case "running":
      return "Working…";
    case "waiting_for_parent":
      return "Waiting for parent…";
    case "paused":
      return hasSubagentCapability(run, "resume")
        ? "Paused; resume when ready."
        : "Interrupted; stop this run and start a replacement when needed.";
    case "reported":
      return "Report delivered; retained backend is idle.";
    case "stopping":
      return "Stopping…";
    case "completed":
      return "Completed without tool activity.";
    case "failed":
      return "No tool activity before failure.";
    case "stopped":
      return "Stopped.";
  }
};

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
  container.addChild(
    new HangingText(
      theme.fg("dim", "selection  "),
      theme.fg("dim", `${candidate} · ${sanitizeTerminalLine(run.selection.reason)}`),
    ),
  );
  for (const skipped of run.selection.skippedCandidates) {
    container.addChild(
      new HangingText(
        theme.fg("dim", "skipped  "),
        theme.fg(
          "dim",
          `${sanitizeTerminalLine(skipped.candidate)} [${sanitizeTerminalLine(skipped.code)}] · ${sanitizeTerminalLine(skipped.reason)}`,
        ),
      ),
    );
  }
  if (run.selection.warning) {
    container.addChild(
      new HangingText(
        theme.fg("warning", "route warning  "),
        theme.fg("warning", sanitizeTerminalLine(run.selection.warning)),
      ),
    );
  }
  container.addChild(
    new HangingText(theme.fg("dim", "cwd  "), theme.fg("dim", sanitizeTerminalLine(run.cwd))),
  );
  if (run.sessionId) {
    container.addChild(
      new HangingText(
        theme.fg("dim", "session id  "),
        theme.fg("dim", sanitizeTerminalLine(run.sessionId)),
      ),
    );
  }
  if (run.sessionFile) {
    container.addChild(
      new HangingText(
        theme.fg("dim", "session  "),
        theme.fg("dim", sanitizeTerminalLine(run.sessionFile)),
      ),
    );
  }
}

export function renderSubagentSessionOutput(
  run: SubagentRunView,
  theme: Theme,
  options: SessionOutputRenderOptions = {},
): Component {
  const now = options.now ?? run.lastActivityAt;
  const container = new Container();
  const name = sanitizeTerminalLine(run.name);
  const subtitle = sanitizeTerminalLine(
    `${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""} · ${run.profile ? `${run.profile} · ` : ""}${run.context} · ${run.model}:${run.effort} · ${runDuration(run, now)}`,
  );
  container.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold(name))}  ${stateLabel(run, theme, now)}`, 0, 0),
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

  const items = activityItems(run.sessionEvents);
  const frame = Math.floor(now / 160);
  for (const item of items) {
    if (item.type === "tools") addToolGroup(container, item.events, theme, frame);
    else addNotice(container, item.event, theme);
  }
  const noticeKinds = new Set(
    items.flatMap((item) => (item.type === "notice" ? [item.event.kind] : [])),
  );
  if (run.question && !noticeKinds.has("question")) {
    container.addChild(
      new HangingText(
        `${theme.fg("warning", "?")} `,
        theme.fg("warning", sanitizeTerminalLine(run.question.message)),
      ),
    );
  }
  if (run.warning && !noticeKinds.has("warning")) {
    container.addChild(
      new HangingText(
        `${theme.fg("warning", "!")} `,
        theme.fg("warning", sanitizeTerminalLine(run.warning)),
      ),
    );
  }
  if (run.progress) {
    container.addChild(
      new HangingText(
        `${theme.fg("muted", "…")} `,
        theme.fg("muted", sanitizeTerminalLine(run.progress)),
      ),
    );
  }
  if (
    items.length === 0 &&
    run.question === undefined &&
    run.warning === undefined &&
    run.progress === undefined
  ) {
    container.addChild(new Text(theme.fg("dim", emptyActivityLabel(run)), 2, 0));
  }

  const assistantOutput =
    run.state === "reported" || !isActiveRunState(run.state) ? run.finalText : undefined;
  if (assistantOutput) {
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
  if (options.showTechnicalDetails) addTechnicalDetails(container, run, theme);
  return container;
}
