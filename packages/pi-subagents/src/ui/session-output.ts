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
import { isActiveRunState, type SubagentRunView, type SubagentSessionEvent } from "../run/model.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./sanitize.ts";

export interface SessionOutputRenderOptions {
  readonly now?: number;
  readonly showTechnicalDetails?: boolean;
}

type ToolEvent = Extract<SubagentSessionEvent, { readonly type: "tool" }>;
type NoticeEvent = Extract<SubagentSessionEvent, { readonly type: "notice" }>;
type ActivityItem =
  | { readonly type: "tools"; readonly events: ReadonlyArray<ToolEvent> }
  | { readonly type: "notice"; readonly event: NoticeEvent };

const compactNumber = (value: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

const formatDuration = (milliseconds: number): string => {
  const safe = Math.max(0, milliseconds);
  if (safe < 1_000) return `${safe}ms`;
  const seconds = Math.round(safe / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

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
  const end = run.endedAt ?? (active ? now : run.lastActivityAt);
  const elapsed = formatDuration(end - run.startedAt);
  if (run.state === "paused") return `paused after ${elapsed}`;
  if (run.state === "waiting_for_parent") return `waiting · ${elapsed}`;
  return active ? `running for ${elapsed}` : elapsed;
};

const stateLabel = (run: SubagentRunView, theme: Theme, now: number): string => {
  const label = run.state;
  switch (run.state) {
    case "completed":
      return theme.fg(
        "success",
        `✓ ${label} ${formatRelativeAge(now - (run.endedAt ?? run.lastActivityAt))}`,
      );
    case "failed":
      return theme.fg("error", `× ${label}`);
    case "stopped":
      return theme.fg("error", `■ ${label}`);
    case "waiting_for_parent":
      return theme.fg("warning", `? ${label}`);
    case "paused":
      return theme.fg("warning", `Ⅱ ${label}`);
    default:
      return theme.fg("accent", `● ${label}`);
  }
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
  for (const event of events) {
    if (event.type === "assistant" || (event.type === "notice" && event.kind === "progress"))
      continue;
    if (event.type === "notice") {
      items.push({ type: "notice", event });
      continue;
    }
    const previous = items.at(-1);
    if (
      previous?.type === "tools" &&
      previous.events.at(-1)?.toolName === event.toolName &&
      previous.events.at(-1)?.state === event.state
    ) {
      items[items.length - 1] = { type: "tools", events: [...previous.events, event] };
    } else {
      items.push({ type: "tools", events: [event] });
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

function addToolGroup(container: Container, events: ReadonlyArray<ToolEvent>, theme: Theme): void {
  const first = events[0];
  if (!first) return;
  const glyph = first.state === "running" ? "●" : first.state === "failed" ? "×" : "✓";
  const color =
    first.state === "running" ? "accent" : first.state === "failed" ? "error" : "success";
  const count = events.length > 1 ? ` ×${events.length}` : "";
  const target =
    events.length === 1 && first.target ? `  ${sanitizeTerminalLine(first.target)}` : "";
  const elapsed = toolDuration(events);
  const body = `${theme.fg("toolTitle", first.toolName)}${theme.fg("muted", count)}${theme.fg("dim", target)}${elapsed ? theme.fg("dim", `  ${elapsed}`) : ""}`;
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
  const color = event.kind === "parent" ? "muted" : event.kind === "question" ? "warning" : "error";
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
      return "Paused.";
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
  const process = [run.id, run.backend, run.execution, run.pid ? `pid ${run.pid}` : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  container.addChild(new Text(theme.fg("dim", process), 2, 0));
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
  container.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold(run.name))}  ${stateLabel(run, theme, now)}`,
      0,
      0,
    ),
  );
  container.addChild(
    new Text(
      theme.fg(
        "dim",
        `${run.writeIntent} · ${run.context} · ${run.model}:${run.effort} · ${runDuration(run, now)}`,
      ),
      0,
      0,
    ),
  );
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
  for (const item of items) {
    if (item.type === "tools") addToolGroup(container, item.events, theme);
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

  const assistantOutput = isActiveRunState(run.state) ? undefined : run.finalText;
  if (assistantOutput) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${theme.fg("accent", theme.bold("Final report"))}  ${theme.fg("dim", "sent to parent")}`,
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
  if (run.error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", `Error: ${run.error}`), 0, 0));
  }

  container.addChild(new Spacer(1));
  const usage = `${compactNumber(run.usage.totalTokens)} tokens · $${run.usage.cost.toFixed(4)}`;
  container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  if (options.showTechnicalDetails) addTechnicalDetails(container, run, theme);
  return container;
}
