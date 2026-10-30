import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { exitStatusMeaning, expandedSection } from "pi-code-previews";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { failingExitCode, type BackgroundTaskSnapshot } from "../task/model.ts";
import { quotedWaitText } from "../ui/compact-summary.ts";
import { failureFactLines, resultFactLines } from "../ui/result-facts.ts";
import { taskDisplayName, taskStatePresentation } from "../ui/task-state.ts";
import {
  backgroundLogLines,
  type BackgroundTaskFailureDetails,
  type BackgroundTaskToolDetails,
} from "./command.ts";
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

interface TaskLineOptions {
  /** The row's heading already names the task, so the line doesn't repeat it. */
  readonly inHeading: boolean;
  /** Collapsed, a failure's exit status is left to the issue that already states it. */
  readonly expanded: boolean;
}

function taskPreviewLine(
  task: BackgroundTaskSnapshot,
  theme: PreviewTheme,
  { inHeading, expanded }: TaskLineOptions,
): string {
  const state = taskStatePresentation(task.state, 0);
  const status = expanded ? exitStatus(task) : undefined;
  return Arr.join(
    [
      ...(inHeading ? [] : [theme.fg("toolOutput", taskDisplayName(task))]),
      theme.fg(state.color, state.label),
      ...(status ? [theme.fg(state.color, status)] : []),
      // An unnamed task's display name is its command.
      ...(task.name && Str.trim(task.name)
        ? [theme.fg("dim", sanitizeTerminalLine(task.command))]
        : []),
    ],
    theme.fg("dim", " · "),
  );
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
  const rows: Row[] = Arr.map(shown, (task) => ({
    text: taskPreviewLine(task, theme, { inHeading: false, expanded }),
  }));
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

function foundRows(
  wait: Extract<BackgroundTaskToolDetails, { readonly action: "wait" }>["wait"],
  theme: PreviewTheme,
): Row[] {
  if (wait.outcome !== "matched") return [];
  const found =
    wait.matchedText === undefined
      ? "Found the awaited output"
      : `Found ${quotedWaitText(wait.matchedText)}`;
  return [
    { text: theme.fg("muted", found) },
    ...(wait.matchedLine
      ? [{ text: theme.fg("toolOutput", sanitizeTerminalLine(wait.matchedLine)) }]
      : []),
  ];
}

function waitRows(
  details: Extract<BackgroundTaskToolDetails, { readonly action: "wait" }>,
  theme: PreviewTheme,
): Row[] {
  const { wait } = details;
  return [
    { text: taskPreviewLine(wait.snapshot, theme, { inHeading: true, expanded: false }) },
    ...foundRows(wait, theme),
    // Expansion shows the whole tail.
    ...(wait.outcome === "completed" ? tailRows(wait.tail, theme) : []),
  ];
}

function emptyListLabel(args: Partial<BackgroundTaskToolInput>): string {
  return EMPTY_LISTS[args.state === "active" || args.state === "completed" ? args.state : "all"];
}

function logRows(
  details: Extract<BackgroundTaskToolDetails, { readonly action: "logs" }>,
  text: string,
  theme: PreviewTheme,
  expanded: boolean,
): Row[] {
  const lines = backgroundLogLines(text, details);
  if (lines.length === 0) return [{ text: theme.fg("muted", "No new output") }];
  return expanded
    ? Arr.map(lines, (line) => ({ text: theme.fg("toolOutput", line) }))
    : boundedLines(lines, "log lines", theme);
}

function collapsedRows(
  details: BackgroundTaskToolDetails,
  text: string,
  args: Partial<BackgroundTaskToolInput>,
  theme: PreviewTheme,
): Row[] {
  const options = { inHeading: true, expanded: false };
  switch (details.action) {
    case "start":
    case "status":
      return [{ text: taskPreviewLine(details.snapshot, theme, options) }];
    case "stop":
      return [
        { text: taskPreviewLine(details.snapshot, theme, options) },
        ...(details.alreadyFinished
          ? [{ text: theme.fg("muted", "Already finished; nothing was stopped") }]
          : []),
      ];
    case "wait":
      return waitRows(details, theme);
    case "list":
      return taskRows(details.tasks, emptyListLabel(args), false, theme);
    case "stop_all":
      return taskRows(details.tasks, EMPTY_LISTS.active, false, theme);
    case "clear":
      return [
        { text: theme.fg("muted", `Removed ${countLabel(details.removed, "completed task")}`) },
      ];
    case "logs":
      return logRows(details, text, theme, false);
  }
  return [];
}

interface Section {
  /** Labeled sections indent beneath their label, like the arguments above them. */
  readonly label?: string;
  readonly rows: Row[];
}

/**
 * Expanded content beyond the heading. A compact heading already states the task and its state, so
 * only a preview heading needs the task's line.
 */
function expandedSections(
  details: BackgroundTaskToolDetails,
  text: string,
  args: Partial<BackgroundTaskToolInput>,
  theme: PreviewTheme,
  headingShowsState: boolean,
): Section[] {
  const taskLine = (task: BackgroundTaskSnapshot): Section[] =>
    headingShowsState
      ? []
      : [{ rows: [{ text: taskPreviewLine(task, theme, { inHeading: true, expanded: true }) }] }];
  switch (details.action) {
    case "start":
    case "status":
      return taskLine(details.snapshot);
    case "stop":
    case "clear":
      return headingShowsState ? [] : [{ rows: collapsedRows(details, text, args, theme) }];
    case "wait": {
      const { wait } = details;
      const tail = wait.tail ? Str.split(Fn.pipe(wait.tail, Str.replace(/\n+$/u, "")), "\n") : [];
      const found = foundRows(wait, theme);
      return [
        ...taskLine(wait.snapshot),
        ...(found.length > 0 ? [{ rows: found }] : []),
        ...(tail.length > 0
          ? [
              {
                label: "Recent output",
                rows: Arr.map(tail, (line) => ({ text: theme.fg("toolOutput", line) })),
              },
            ]
          : []),
      ];
    }
    case "list":
      return [{ label: "Tasks", rows: taskRows(details.tasks, emptyListLabel(args), true, theme) }];
    case "stop_all":
      return [{ label: "Tasks", rows: taskRows(details.tasks, EMPTY_LISTS.active, true, theme) }];
    case "logs":
      return [{ label: "Output", rows: logRows(details, text, theme, true) }];
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
  readonly failure: Option.Option<BackgroundTaskFailureDetails>;
  readonly text: string;
  readonly args: Partial<BackgroundTaskToolInput>;
  readonly expanded: boolean;
  readonly isError: boolean;
  /** A compact heading, which already states the task and its state. */
  readonly headingShowsState?: boolean;
}

function previewSections(input: BackgroundTaskPreviewInput, theme: PreviewTheme): Section[] {
  const { text, args, expanded } = input;
  // The shell shows a failure's issue; its facts are details.
  if (Option.isSome(input.failure)) return [];
  if (Option.isNone(input.details)) {
    if (expanded) return [{ rows: rawRows(text, theme) }];
    if (input.isError) return [];
    const lines = Fn.pipe(text, Str.replace(/\n+$/u, ""), Str.split("\n"));
    return [{ rows: boundedLines(lines, "lines", theme) }];
  }
  const details = input.details.value;
  if (!expanded) return [{ rows: collapsedRows(details, text, args, theme) }];
  return Arr.map(
    expandedSections(details, text, args, theme, input.headingShowsState === true),
    (section) => ({ ...section, rows: Arr.map(section.rows, (row) => ({ ...row, wrap: true })) }),
  );
}

/** The technical facts of an expanded result, decoded from its details. */
function factLines(input: BackgroundTaskPreviewInput): ReadonlyArray<string> {
  if (!input.expanded) return [];
  return Option.match(input.failure, {
    onSome: ({ failure }) => failureFactLines(failure),
    onNone: () => Option.match(input.details, { onSome: resultFactLines, onNone: () => [] }),
  });
}

function rowsComponent(rows: ReadonlyArray<Row>): Component {
  let cached: { readonly width: number; readonly lines: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.lines;
      const lines = Arr.flatMap(rows, (row) =>
        row.wrap ? wrapTextWithAnsi(row.text, width) : [clipToWidth(row.text, width)],
      );
      cached = { width, lines };
      return lines;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

function buildPreview(input: BackgroundTaskPreviewInput, theme: Theme): Component {
  const container = new Container();
  for (const section of previewSections(input, theme)) {
    const rows = rowsComponent(section.rows);
    container.addChild(
      section.label === undefined ? rows : expandedSection(theme, section.label, rows),
    );
  }
  const facts = factLines(input);
  if (facts.length > 0)
    container.addChild(
      expandedSection(theme, "Details", new Text(theme.fg("dim", Arr.join(facts, "\n")), 0, 0)),
    );
  return container;
}

export function renderBackgroundTaskPreview(
  input: BackgroundTaskPreviewInput,
  theme: Theme,
): Component {
  // Built on first draw and again after invalidation, so theme changes restyle every row.
  let built: Component | undefined;
  return {
    render(width) {
      built ??= buildPreview(input, theme);
      return built.render(width);
    },
    invalidate() {
      built = undefined;
    },
  };
}
