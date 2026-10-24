import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { exitStatusMeaning } from "pi-code-previews";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { failingExitCode, type BackgroundTaskSnapshot } from "../task/model.ts";
import { quotedWaitText, resultSnapshot } from "../ui/compact-summary.ts";
import { taskDisplayName, taskStatePresentation } from "../ui/task-state.ts";
import { backgroundLogLines, type BackgroundTaskToolDetails } from "./command.ts";
import type { BackgroundTaskToolInput } from "./schema.ts";

type PreviewTheme = Pick<Theme, "fg" | "bold">;

const LOG_HEAD_LINES = 8;
const LOG_TAIL_LINES = 4;
const COLLAPSED_TASK_ROWS = 8;

function exitStatus(task: BackgroundTaskSnapshot): string | undefined {
  if (task.state !== "failed" && task.state !== "exited") return undefined;
  const exitCode = failingExitCode(task);
  if (exitCode !== undefined) {
    const meaning = exitStatusMeaning(exitCode);
    return `exit ${exitCode}${meaning ? `: ${meaning}` : ""}`;
  }
  if (!task.signal) return undefined;
  const meaning = exitStatusMeaning(undefined, task.signal);
  return `signal ${sanitizeTerminalLine(task.signal)}${meaning ? `: ${meaning}` : ""}`;
}

function taskPreviewLine(task: BackgroundTaskSnapshot, theme: PreviewTheme): string {
  const state = taskStatePresentation(task.state, 0);
  const status = exitStatus(task);
  return Arr.join(
    [
      theme.fg("toolOutput", taskDisplayName(task)),
      theme.fg(state.color, state.label),
      ...(status ? [theme.fg(state.color, status)] : []),
      ...(task.name && Str.trim(task.name)
        ? [theme.fg("dim", sanitizeTerminalLine(task.command))]
        : []),
    ],
    theme.fg("dim", " · "),
  );
}

export function taskProcessLine(task: BackgroundTaskSnapshot, theme: PreviewTheme): string {
  const pid = task.pid === undefined ? [] : [`pid ${task.pid}`];
  return theme.fg("muted", Arr.join([sanitizeTerminalLine(task.cwd), ...pid], " · "));
}

interface Row {
  readonly text: string;
  readonly wrap?: boolean;
}

const hiddenMarker = (hidden: number, theme: PreviewTheme): Row => ({
  text: theme.fg("muted", `--- ${countLabel(hidden, "line")} hidden ---`),
});

function boundedLines(lines: ReadonlyArray<string>, label: string, theme: PreviewTheme): Row[] {
  const shown = LOG_HEAD_LINES + LOG_TAIL_LINES;
  const text = (line: string): Row => ({ text: theme.fg("toolOutput", line) });
  if (lines.length <= shown) return Arr.map(lines, text);
  return [
    ...Arr.map(lines.slice(0, LOG_HEAD_LINES), text),
    hiddenMarker(lines.length - shown, theme),
    ...Arr.map(lines.slice(-LOG_TAIL_LINES), text),
    {
      text: renderExpansionAffordance(`Showing ${shown} of ${lines.length} ${label}`, false, theme),
    },
  ];
}

function taskRows(
  tasks: ReadonlyArray<BackgroundTaskSnapshot>,
  empty: string,
  expanded: boolean,
  theme: PreviewTheme,
): Row[] {
  if (tasks.length === 0) return [{ text: theme.fg("muted", empty) }];
  const shown = expanded ? tasks : tasks.slice(0, COLLAPSED_TASK_ROWS);
  const rows: Row[] = Arr.map(shown, (task) => ({ text: taskPreviewLine(task, theme) }));
  if (shown.length < tasks.length)
    rows.push({
      text: renderExpansionAffordance(
        `Showing ${shown.length} of ${tasks.length} tasks`,
        false,
        theme,
      ),
    });
  return rows;
}

const EMPTY_LISTS = {
  active: "No active tasks",
  completed: "No completed tasks",
  all: "No background tasks",
} as const;

const COLLAPSED_TAIL_LINES = 4;

/** The last few lines of a finished task's output, collapsed; expansion shows the full result. */
function tailRows(tail: string | undefined, theme: PreviewTheme): Row[] {
  const lines = tail ? Str.split(Fn.pipe(tail, Str.replace(/\n+$/u, "")), "\n") : [];
  if (lines.length === 0) return [];
  const shown = lines.slice(-COLLAPSED_TAIL_LINES);
  return [
    ...Arr.map(shown, (line) => ({ text: theme.fg("toolOutput", line) })),
    ...(shown.length < lines.length
      ? [
          {
            text: renderExpansionAffordance(
              `Showing ${shown.length} of ${lines.length} recent lines`,
              false,
              theme,
            ),
          },
        ]
      : []),
  ];
}

function waitRows(
  details: Extract<BackgroundTaskToolDetails, { readonly action: "wait" }>,
  expanded: boolean,
  theme: PreviewTheme,
): Row[] {
  const { wait } = details;
  const found =
    wait.outcome === "matched"
      ? wait.matchedText === undefined
        ? "Found the awaited output"
        : `Found ${quotedWaitText(wait.matchedText)}`
      : undefined;
  return [
    { text: taskPreviewLine(wait.snapshot, theme) },
    ...(found ? [{ text: theme.fg("muted", found) }] : []),
    ...(found && wait.matchedLine
      ? [{ text: theme.fg("toolOutput", sanitizeTerminalLine(wait.matchedLine)) }]
      : []),
    // Expansion shows the whole tail in the raw result.
    ...(wait.outcome === "completed" && !expanded ? tailRows(wait.tail, theme) : []),
  ];
}

function detailRows(
  details: BackgroundTaskToolDetails,
  text: string,
  args: Partial<BackgroundTaskToolInput>,
  expanded: boolean,
  theme: PreviewTheme,
): Row[] {
  switch (details.action) {
    case "start":
    case "status":
      return [{ text: taskPreviewLine(details.snapshot, theme) }];
    case "stop":
      return [
        { text: taskPreviewLine(details.snapshot, theme) },
        ...(details.alreadyFinished
          ? [{ text: theme.fg("muted", "Already finished; nothing was stopped") }]
          : []),
      ];
    case "wait":
      return waitRows(details, expanded, theme);
    case "list":
      return taskRows(
        details.tasks,
        EMPTY_LISTS[args.state === "active" || args.state === "completed" ? args.state : "all"],
        expanded,
        theme,
      );
    case "stop_all":
      return taskRows(details.tasks, EMPTY_LISTS.active, expanded, theme);
    case "clear":
      return [
        { text: theme.fg("muted", `Removed ${countLabel(details.removed, "completed task")}`) },
      ];
    case "logs": {
      const lines = backgroundLogLines(text, details);
      return lines.length === 0
        ? [{ text: theme.fg("muted", "No new output") }]
        : boundedLines(lines, "log lines", theme);
    }
  }
  return [];
}

function rawRows(text: string, theme: PreviewTheme): Row[] {
  const raw = Fn.pipe(text, Str.replace(/\n+$/u, ""));
  if (!raw) return [];
  return [
    { text: theme.fg("muted", "Raw result") },
    ...Arr.map(Str.split(raw, "\n"), (line) => ({
      text: theme.fg("toolOutput", line),
      wrap: true,
    })),
  ];
}

export interface BackgroundTaskPreviewInput {
  readonly details: Option.Option<BackgroundTaskToolDetails>;
  readonly text: string;
  readonly args: Partial<BackgroundTaskToolInput>;
  readonly expanded: boolean;
  readonly isError: boolean;
}

function previewRows(input: BackgroundTaskPreviewInput, theme: PreviewTheme): Row[] {
  const { text, args, expanded } = input;
  if (Option.isNone(input.details)) {
    if (expanded) return rawRows(text, theme);
    return input.isError
      ? []
      : boundedLines(Fn.pipe(text, Str.replace(/\n+$/u, ""), Str.split("\n")), "lines", theme);
  }
  const details = input.details.value;
  if (!expanded) return detailRows(details, text, args, false, theme);
  const body = details.action === "logs" ? [] : detailRows(details, text, args, true, theme);
  const snapshot = resultSnapshot(details);
  return [
    ...Arr.map(body, (row) => ({ text: row.text, wrap: true })),
    ...(snapshot ? [{ text: taskProcessLine(snapshot, theme), wrap: true }] : []),
    ...rawRows(text, theme),
  ];
}

export function renderBackgroundTaskPreview(
  input: BackgroundTaskPreviewInput,
  theme: PreviewTheme,
): Component {
  let rows: Row[] | undefined;
  let cached: { readonly width: number; readonly lines: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.lines;
      rows ??= previewRows(input, theme);
      const lines = Arr.flatMap(rows, (row) =>
        row.wrap ? wrapTextWithAnsi(row.text, width) : [clipToWidth(row.text, width)],
      );
      cached = { width, lines };
      return lines;
    },
    invalidate() {
      rows = undefined;
      cached = undefined;
    },
  };
}
