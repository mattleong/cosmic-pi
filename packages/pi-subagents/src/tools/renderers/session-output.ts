import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentRunView, SubagentSessionEvent } from "../../run/model.ts";
import { sanitizeTerminalLine } from "../../ui/sanitize.ts";

const compactNumber = (value: number): string =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

const duration = (startedAt: number, endedAt: number): string => {
  const milliseconds = Math.max(0, endedAt - startedAt);
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

const stateLabel = (run: SubagentRunView, theme: Theme): string => {
  const label = run.state.toUpperCase();
  switch (run.state) {
    case "completed":
      return theme.fg("success", label);
    case "failed":
    case "stopped":
      return theme.fg("error", label);
    case "waiting_for_parent":
    case "paused":
      return theme.fg("warning", label);
    default:
      return theme.fg("accent", label);
  }
};

const toolLine = (
  event: Extract<SubagentSessionEvent, { readonly type: "tool" }>,
  theme: Theme,
) => {
  const glyph = event.state === "running" ? "●" : event.state === "failed" ? "×" : "✓";
  const color =
    event.state === "running" ? "accent" : event.state === "failed" ? "error" : "success";
  const elapsed = event.endedAt === undefined ? "" : ` ${duration(event.startedAt, event.endedAt)}`;
  const target = event.target ? `  ${theme.fg("dim", sanitizeTerminalLine(event.target))}` : "";
  return `${theme.fg(color, glyph)} ${theme.fg("toolTitle", event.toolName)}${target}${theme.fg("dim", elapsed)}`;
};

function addSessionEvent(container: Container, event: SubagentSessionEvent, theme: Theme): void {
  if (event.type === "assistant") return;
  if (event.type === "tool") {
    container.addChild(new Text(toolLine(event, theme), 2, 0));
    return;
  }
  if (event.kind === "progress") return;
  const glyph = event.kind === "parent" ? "←" : event.kind === "question" ? "?" : "!";
  const color = event.kind === "parent" ? "muted" : event.kind === "question" ? "warning" : "error";
  container.addChild(
    new Text(
      `${theme.fg(color, glyph)} ${theme.fg(color, sanitizeTerminalLine(event.text))}`,
      2,
      0,
    ),
  );
}

export function renderSubagentSessionOutput(run: SubagentRunView, theme: Theme): Component {
  const container = new Container();
  container.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold(run.name))} ${theme.fg("dim", run.id)}  ${stateLabel(run, theme)}`,
      0,
      0,
    ),
  );
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Task")), 0, 0));
  container.addChild(
    new Markdown(run.task, 2, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("toolOutput", text),
    }),
  );
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", theme.bold("Session output")), 0, 0));
  const activity = run.sessionEvents.filter((event) => event.type !== "assistant");
  for (const event of activity) addSessionEvent(container, event, theme);
  const noticeKinds = new Set(
    activity.flatMap((event) => (event.type === "notice" ? [event.kind] : [])),
  );
  if (run.question && !noticeKinds.has("question")) {
    container.addChild(
      new Text(theme.fg("warning", `? ${sanitizeTerminalLine(run.question.message)}`), 2, 0),
    );
  }
  if (run.warning && !noticeKinds.has("warning")) {
    container.addChild(
      new Text(theme.fg("warning", `! ${sanitizeTerminalLine(run.warning)}`), 2, 0),
    );
  }
  if (run.progress) {
    container.addChild(
      new Text(theme.fg("muted", `… ${sanitizeTerminalLine(run.progress)}`), 2, 0),
    );
  }
  if (
    activity.length === 0 &&
    run.question === undefined &&
    run.warning === undefined &&
    run.progress === undefined
  ) {
    container.addChild(new Text(theme.fg("dim", "No child activity yet."), 2, 0));
  }
  const assistantOutput =
    run.finalText ??
    [...run.sessionEvents].reverse().find((event) => event.type === "assistant")?.text;
  if (assistantOutput) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Assistant")), 0, 0));
    container.addChild(
      new Markdown(assistantOutput, 2, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("toolOutput", text),
      }),
    );
  }
  if (run.error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("error", `Error: ${run.error}`), 0, 0));
  }
  container.addChild(new Spacer(1));
  const endedAt = run.endedAt ?? run.lastActivityAt;
  const usage = `${compactNumber(run.usage.totalTokens)} tokens · $${run.usage.cost.toFixed(4)}`;
  container.addChild(
    new Text(
      theme.fg(
        "dim",
        `${run.context} · ${run.writeIntent} · ${run.model}:${run.effort} · ${duration(run.startedAt, endedAt)} · ${usage}`,
      ),
      0,
      0,
    ),
  );
  if (run.sessionFile)
    container.addChild(new Text(theme.fg("dim", `session ${run.sessionFile}`), 0, 0));
  return container;
}
