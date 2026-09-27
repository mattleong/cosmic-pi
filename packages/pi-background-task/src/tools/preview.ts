/**
 * Preview-style bodies for `background_task`: what the typed details say, in people's words, under
 * the shell's heading and issue lines. The agent's raw text appears only once expanded.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { exitStatusMeaning } from "pi-code-previews";
import { countLabel, sanitizeTerminalLine } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import type { BackgroundTaskSnapshot } from "../task/model.ts";
import { quotedWaitText } from "../ui/compact-summary.ts";
import { taskDisplayName, taskStatePresentation } from "../ui/task-state.ts";
import { backgroundLogLines, type BackgroundTaskToolDetails } from "./command.ts";
import type { BackgroundTaskToolInput } from "./schema.ts";

type PreviewTheme = Pick<Theme, "fg" | "bold">;

/** Collapsed log previews show a head and a tail around one hidden-lines marker. */
const LOG_HEAD_LINES = 8;
const LOG_TAIL_LINES = 4;
const COLLAPSED_TASK_ROWS = 8;

/** What ended a task, when it is worth saying: a non-zero exit or a signal, with its meaning. */
function exitStatus(task: BackgroundTaskSnapshot): string | undefined {
  if (task.state !== "failed" && task.state !== "exited") return undefined;
  if (task.exitCode != null && task.exitCode !== 0) {
    const meaning = exitStatusMeaning(task.exitCode);
    return `exit ${task.exitCode}${meaning ? `: ${meaning}` : ""}`;
  }
  if (!task.signal) return undefined;
  const meaning = exitStatusMeaning(undefined, task.signal);
  return `signal ${sanitizeTerminalLine(task.signal)}${meaning ? `: ${meaning}` : ""}`;
}

/** One task as people know it: name, state, how it ended, and the command a name stands for. */
function taskPreviewLine(task: BackgroundTaskSnapshot, theme: PreviewTheme): string {
  const state = taskStatePresentation(task.state, 0);
  const status = exitStatus(task);
  return [
    theme.fg("toolOutput", taskDisplayName(task)),
    theme.fg(state.color, state.label),
    ...(status ? [theme.fg(state.color, status)] : []),
    ...(task.name?.trim() ? [theme.fg("dim", sanitizeTerminalLine(task.command))] : []),
  ].join(theme.fg("dim", " · "));
}

/** Where a task runs: its working directory and process ID. */
export function taskProcessLine(task: BackgroundTaskSnapshot, theme: PreviewTheme): string {
  const pid = task.pid === undefined ? [] : [`pid ${task.pid}`];
  return theme.fg("muted", [sanitizeTerminalLine(task.cwd), ...pid].join(" · "));
}

/** The one snapshot a single-task result carries. */
export function resultSnapshot(
  details: BackgroundTaskToolDetails,
): BackgroundTaskSnapshot | undefined {
  if (details.action === "start" || details.action === "status" || details.action === "stop")
    return details.snapshot;
  return details.action === "wait" ? details.wait.snapshot : undefined;
}

/** A row that is clipped to one line collapsed and wrapped once expanded. */
interface Row {
  readonly text: string;
  readonly wrap?: boolean;
}

const hiddenMarker = (hidden: number, theme: PreviewTheme): Row => ({
  text: theme.fg("muted", `--- ${countLabel(hidden, "line")} hidden ---`),
});

/** A bounded head and tail of `lines`, then how many show, counting only these lines. */
function boundedLines(lines: ReadonlyArray<string>, label: string, theme: PreviewTheme): Row[] {
  const shown = LOG_HEAD_LINES + LOG_TAIL_LINES;
  const text = (line: string): Row => ({ text: theme.fg("toolOutput", line) });
  if (lines.length <= shown) return lines.map(text);
  return [
    ...lines.slice(0, LOG_HEAD_LINES).map(text),
    hiddenMarker(lines.length - shown, theme),
    ...lines.slice(-LOG_TAIL_LINES).map(text),
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
  const rows: Row[] = shown.map((task) => ({ text: taskPreviewLine(task, theme) }));
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

/** The result in people's words, without the raw agent text. */
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
    case "stop":
      return [{ text: taskPreviewLine(details.snapshot, theme) }];
    case "wait": {
      const found =
        details.wait.outcome === "matched"
          ? Predicate.isString(args.contains) && args.contains
            ? `Found ${quotedWaitText(args.contains)}`
            : "Found the awaited output"
          : undefined;
      return [
        { text: taskPreviewLine(details.wait.snapshot, theme) },
        ...(found ? [{ text: theme.fg("muted", found) }] : []),
      ];
    }
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
      const lines = backgroundLogLines(text, details.logs);
      return lines.length === 0
        ? [{ text: theme.fg("muted", "No new output") }]
        : boundedLines(lines, "log lines", theme);
    }
  }
}

/** The agent's text, labelled, for expanded views. */
function rawRows(text: string, theme: PreviewTheme): Row[] {
  const raw = text.replace(/\n+$/u, "");
  if (!raw) return [];
  return [
    { text: theme.fg("muted", "Raw result") },
    ...raw.split("\n").map((line) => ({ text: theme.fg("toolOutput", line), wrap: true })),
  ];
}

export interface BackgroundTaskPreviewInput {
  readonly details: Option.Option<BackgroundTaskToolDetails>;
  /** The result's text with terminal controls removed. */
  readonly text: string;
  readonly args: Partial<BackgroundTaskToolInput>;
  readonly expanded: boolean;
  readonly isError: boolean;
}

function previewRows(input: BackgroundTaskPreviewInput, theme: PreviewTheme): Row[] {
  const { text, args, expanded } = input;
  if (Option.isNone(input.details)) {
    // Undecodable details have no human view. A rejected call's message is the shell's issue.
    if (expanded) return rawRows(text, theme);
    return input.isError ? [] : boundedLines(text.replace(/\n+$/u, "").split("\n"), "lines", theme);
  }
  const details = input.details.value;
  if (!expanded) return detailRows(details, text, args, false, theme);
  // Expanded logs are the raw slice itself; repeating every log line above it adds nothing.
  const body = details.action === "logs" ? [] : detailRows(details, text, args, true, theme);
  const snapshot = resultSnapshot(details);
  return [
    ...body.map((row) => ({ ...row, wrap: true })),
    ...(snapshot ? [{ text: taskProcessLine(snapshot, theme), wrap: true }] : []),
    ...rawRows(text, theme),
  ];
}

/** Preview body: rows computed once, laid out per width, recomputed only on invalidation. */
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
      const lines = rows.flatMap((row) =>
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
