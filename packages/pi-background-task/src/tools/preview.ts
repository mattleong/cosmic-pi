import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  exitStatusMeaning,
  expandedDetails,
  expandedFields,
  expandedSection,
} from "pi-code-previews";
import { countLabel, formatDuration } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  clipToWidth,
  managerActivityColor,
  managerNoticeColor,
  managerNoticeGlyph,
  SUITE_STATUS_GLYPHS,
} from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { failingExitCode, type BackgroundTaskSnapshot } from "../task/model.ts";
import {
  listedTaskIssues,
  listedTaskOutcome,
  quotedWaitText,
  type TaskOutcome,
} from "../ui/compact-summary.ts";
import { styledTaskOutputLine } from "../ui/output-lines.ts";
import { failureFactLines, resultFactLines } from "../ui/result-facts.ts";
import { taskDisplayName, taskStatePresentation } from "../ui/task-state.ts";
import {
  backgroundLogLines,
  type BackgroundTaskFailureDetails,
  type BackgroundTaskToolDetails,
} from "./command.ts";
import type { BackgroundTaskToolInput } from "./schema.ts";
import { commandLines, requestTaskId, type LabeledRow } from "./request-view.ts";

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
  /** A start result, which reports the admission rather than a state that later goes stale. */
  readonly started?: boolean;
  /** A listed row whose issues follow beneath it. */
  readonly issuesBeneath?: boolean;
}

const startedState = (task: BackgroundTaskSnapshot): boolean =>
  task.state === "starting" || task.state === "running";

// A listed row's status glyph, as other suite lists mark them; a running task in a saved
// result is neutral, since a spinner would freeze.
const LISTED_GLYPHS = {
  success: { glyph: SUITE_STATUS_GLYPHS.succeeded, color: "success" },
  error: { glyph: SUITE_STATUS_GLYPHS.failed, color: "error" },
  cancelled: { glyph: SUITE_STATUS_GLYPHS.stopped, color: "muted" },
  uncertain: { glyph: SUITE_STATUS_GLYPHS.uncertain, color: "warning" },
  returned: { glyph: SUITE_STATUS_GLYPHS.neutral, color: "accent" },
} as const satisfies Record<
  TaskOutcome,
  { readonly glyph: string; readonly color: Parameters<PreviewTheme["fg"]>[0] }
>;

const listedGlyph = (task: BackgroundTaskSnapshot, theme: PreviewTheme): string => {
  const { glyph, color } =
    task.state === "stopping"
      ? ({ glyph: SUITE_STATUS_GLYPHS.stopping, color: "warning" } as const)
      : LISTED_GLYPHS[listedTaskOutcome(task)];
  return theme.fg(color, glyph);
};

/**
 * A listed row's state in words, unless its glyph already says it (finished or failed) or, for a
 * timeout, an issue beneath the row does.
 */
const listedStateShown = (task: BackgroundTaskSnapshot, issuesBeneath: boolean): boolean =>
  task.state !== "exited" &&
  task.state !== "failed" &&
  !(task.state === "timed_out" && issuesBeneath);

function taskPreviewLine(
  task: BackgroundTaskSnapshot,
  theme: PreviewTheme,
  { inHeading, expanded, started = false, issuesBeneath = false }: TaskLineOptions,
): string {
  const state =
    started && startedState(task)
      ? { color: managerActivityColor("done"), label: "started" }
      : taskStatePresentation(task.state);
  const status = expanded ? exitStatus(task) : undefined;
  const stateShown = inHeading || listedStateShown(task, issuesBeneath);
  const name = `${listedGlyph(task, theme)} ${theme.fg("toolOutput", taskDisplayName(task))}`;
  return Arr.join(
    [
      ...(inHeading ? [] : [name]),
      ...(stateShown ? [theme.fg(state.color, state.label)] : []),
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
  /** Columns that wrapped continuation rows indent, hanging beneath the row's first line. */
  readonly hang?: number;
}

const hiddenMarker = (hidden: number, theme: PreviewTheme): Row => ({
  text: theme.fg("muted", `--- ${countLabel(hidden, "line")} hidden ---`),
});

function boundedLines(lines: ReadonlyArray<string>, label: string, theme: PreviewTheme): Row[] {
  const shown = LOG_HEAD_LINES + LOG_TAIL_LINES;
  const text = (line: string): Row => ({ text: styledTaskOutputLine(line, theme) });
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

/** A listed task's issues beneath its row, marked as the suite marks each severity. */
function taskIssueRows(task: BackgroundTaskSnapshot, theme: PreviewTheme): Row[] {
  return Arr.flatMap(listedTaskIssues(task), (entry) => [
    {
      text: `  ${theme.fg(managerNoticeColor(entry.severity), managerNoticeGlyph(entry.severity))} ${theme.fg("toolOutput", entry.message)}`,
      hang: 4,
    },
    ...(entry.detail === undefined
      ? []
      : Arr.map(Str.split(entry.detail, "\n"), (line) => ({
          text: `    ${theme.fg("muted", line)}`,
          hang: 4,
        }))),
  ]);
}

/**
 * Task rows. An expanded listing puts each task's issues beneath it; they state its exit status,
 * so the row leaves that out.
 */
function taskRows(
  tasks: ReadonlyArray<BackgroundTaskSnapshot>,
  empty: string,
  expanded: boolean,
  theme: PreviewTheme,
  listing = false,
): Row[] {
  if (tasks.length === 0) return [{ text: theme.fg("muted", empty) }];
  const shown = expanded ? tasks : tasks.slice(0, COLLAPSED_TASK_ROWS);
  const issues = expanded && listing;
  const rows: Row[] = Arr.flatMap(shown, (task) => [
    {
      text: taskPreviewLine(task, theme, {
        inHeading: false,
        expanded: expanded && !issues,
        issuesBeneath: issues,
      }),
      hang: 2,
    },
    ...(issues ? taskIssueRows(task, theme) : []),
  ]);
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

const outputLines = (text: string): string[] =>
  Str.split(Fn.pipe(text, Str.replace(/\n+$/u, "")), "\n");

/** The last few lines of a finished task's output, collapsed; expansion shows the full result. */
function tailRows(tail: string | undefined, theme: PreviewTheme): Row[] {
  const lines = tail ? outputLines(tail) : [];
  if (lines.length === 0) return [];
  const shown = lines.slice(-COLLAPSED_TAIL_LINES);
  return [
    ...Arr.map(shown, (line) => ({ text: styledTaskOutputLine(line, theme) })),
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
    ? Arr.map(lines, (line) => ({ text: styledTaskOutputLine(line, theme) }))
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
      return [{ text: taskPreviewLine(details.snapshot, theme, { ...options, started: true }) }];
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
  /** Labeled facts, drawn in a shared label column beneath the heading instead of rows. */
  readonly facts?: ReadonlyArray<LabeledRow>;
}

/** What a compact heading doesn't say about one task: its command when named, and its runtime. */
function taskFacts(task: BackgroundTaskSnapshot): Section[] {
  const named = task.name !== undefined && Str.trim(task.name) !== "";
  const facts: LabeledRow[] = [
    ...(named ? [{ label: "Command", lines: commandLines(task.command) }] : []),
    // A timeout's issue already says how long it ran.
    ...(task.endedAt === undefined || task.state === "timed_out"
      ? []
      : [{ label: "Ran", lines: [formatDuration(task.endedAt - task.startedAt)] }]),
  ];
  return facts.length > 0 ? [{ rows: [], facts }] : [];
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
  const taskLine = (task: BackgroundTaskSnapshot, started = false): Section[] =>
    headingShowsState
      ? started
        ? []
        : taskFacts(task)
      : [
          {
            rows: [
              { text: taskPreviewLine(task, theme, { inHeading: true, expanded: true, started }) },
            ],
          },
        ];
  switch (details.action) {
    case "start":
      return taskLine(details.snapshot, true);
    case "status":
      return taskLine(details.snapshot);
    case "stop":
      return headingShowsState
        ? taskFacts(details.snapshot)
        : [{ rows: collapsedRows(details, text, args, theme) }];
    case "clear":
      return headingShowsState ? [] : [{ rows: collapsedRows(details, text, args, theme) }];
    case "wait": {
      const { wait } = details;
      const tail = wait.tail ? outputLines(wait.tail) : [];
      // A compact heading already says what was found; only the line around it is new.
      const found = headingShowsState
        ? wait.matchedLine
          ? [{ text: theme.fg("toolOutput", sanitizeTerminalLine(wait.matchedLine)) }]
          : []
        : foundRows(wait, theme);
      return [
        ...taskLine(wait.snapshot),
        ...(found.length > 0
          ? [headingShowsState ? { label: "Matched line", rows: found } : { rows: found }]
          : []),
        ...(tail.length > 0
          ? [
              {
                label: "Recent output",
                rows: Arr.map(tail, (line) => ({ text: styledTaskOutputLine(line, theme) })),
              },
            ]
          : []),
      ];
    }
    case "list":
      return [
        { label: "Tasks", rows: taskRows(details.tasks, emptyListLabel(args), true, theme, true) },
      ];
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
    return [{ rows: boundedLines(outputLines(text), "lines", theme) }];
  }
  const details = input.details.value;
  if (!expanded) return [{ rows: collapsedRows(details, text, args, theme) }];
  return Arr.map(
    expandedSections(details, text, args, theme, input.headingShowsState === true),
    (section) => ({ ...section, rows: Arr.map(section.rows, (row) => ({ ...row, wrap: true })) }),
  );
}

/**
 * The technical facts of an expanded result, decoded from its details. Every action's Details
 * lead with the task ID: a result that doesn't name it keeps the requested one.
 */
function factLines(input: BackgroundTaskPreviewInput): ReadonlyArray<string> {
  if (!input.expanded) return [];
  const facts = Option.match(input.failure, {
    onSome: ({ failure }) => failureFactLines(failure),
    onNone: () =>
      Option.match(input.details, {
        onSome: (details) => Arr.filter(resultFactLines(details), (line) => line !== ""),
        onNone: () => [],
      }),
  });
  const id = requestTaskId(input.args);
  return id === undefined || Arr.some(facts, (line) => Fn.pipe(line, Str.includes(id)))
    ? facts
    : [id, ...facts];
}

/** Wraps within `width`, indenting continuation rows `hang` columns. */
function hangingRows(text: string, width: number, hang: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const indent = Math.min(hang, Math.max(0, width - 1));
  return Arr.map(wrapTextWithAnsi(text, Math.max(1, width - indent)), (part, index) =>
    index === 0 ? part : `${Str.repeat(indent)(" ")}${Str.trimStart(part)}`,
  );
}

function rowsComponent(rows: ReadonlyArray<Row>): Component {
  let cached: { readonly width: number; readonly lines: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.lines;
      const lines = Arr.flatMap(rows, (row) =>
        row.wrap
          ? row.hang === undefined
            ? wrapTextWithAnsi(row.text, width)
            : hangingRows(row.text, width, row.hang)
          : [clipToWidth(row.text, width)],
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
  // Expanded, unlabeled rows indent with the labeled sections around them.
  const indentUnlabeled = input.expanded;
  for (const section of previewSections(input, theme)) {
    if (section.facts !== undefined) {
      container.addChild(expandedFields(theme, section.facts));
      continue;
    }
    const rows = rowsComponent(section.rows);
    container.addChild(
      section.label !== undefined
        ? expandedSection(theme, section.label, rows)
        : indentUnlabeled
          ? expandedSection(theme, undefined, rows)
          : rows,
    );
  }
  container.addChild(expandedDetails(theme, factLines(input)));
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
