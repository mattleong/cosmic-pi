import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
  INLINE_SEPARATOR,
  joinInline,
  managerActivityColor,
  managerNoticeColor,
  managerNoticeGlyph,
  SUITE_STATUS_GLYPHS,
  wrapFacts,
} from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { countTaskStates, failingExitCode, type BackgroundTaskSnapshot } from "../task/model.ts";
import {
  listedTaskIssues,
  listedTaskOutcome,
  quotedWaitText,
  type TaskOutcome,
} from "../ui/compact-summary.ts";
import { styledTaskOutputLine } from "../ui/output-lines.ts";
import { failureFactLines, resultFactLines } from "../ui/result-facts.ts";
import { emptyTaskListLabel, taskDisplayName, taskStatePresentation } from "../ui/task-state.ts";
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

const listedGlyph = (task: BackgroundTaskSnapshot) =>
  task.state === "stopping"
    ? ({ glyph: SUITE_STATUS_GLYPHS.stopping, color: "warning" } as const)
    : LISTED_GLYPHS[listedTaskOutcome(task)];

/**
 * A listed row's state in words, unless its glyph already says it (finished or failed) or, for a
 * timeout, an issue beneath the row does.
 */
const listedStateShown = (task: BackgroundTaskSnapshot, issuesBeneath: boolean): boolean =>
  task.state !== "exited" &&
  task.state !== "failed" &&
  !(task.state === "timed_out" && issuesBeneath);

/** Text drawn in one style; a fact is one or more of them. */
interface Styled {
  readonly text: string;
  readonly style: (text: string) => string;
}

type Fact = ReadonlyArray<Styled>;

interface Row {
  readonly text: string;
  /** A row of facts, which wraps between whole facts. */
  readonly facts?: ReadonlyArray<Fact>;
  readonly wrap?: boolean;
  /** Columns that wrapped continuation rows indent, hanging beneath the row's first line. */
  readonly hang?: number;
}

function taskPreviewRow(
  task: BackgroundTaskSnapshot,
  theme: PreviewTheme,
  { inHeading, expanded, started = false, issuesBeneath = false }: TaskLineOptions,
): Row {
  const state =
    started && startedState(task)
      ? { color: managerActivityColor("done"), label: "started" }
      : taskStatePresentation(task.state);
  const status = expanded ? exitStatus(task) : undefined;
  const stateShown = inHeading || listedStateShown(task, issuesBeneath);
  const stateStyle = (text: string) => theme.fg(state.color, text);
  const { glyph, color } = listedGlyph(task);
  const facts: Fact[] = [
    ...(inHeading
      ? []
      : [
          [
            { text: `${glyph} `, style: (text: string) => theme.fg(color, text) },
            { text: taskDisplayName(task), style: (text: string) => theme.fg("toolOutput", text) },
          ],
        ]),
    ...(stateShown ? [[{ text: state.label, style: stateStyle }]] : []),
    ...(status ? [[{ text: status, style: stateStyle }]] : []),
    // An unnamed task's display name is its command.
    ...(task.name && Str.trim(task.name)
      ? [
          [
            {
              text: sanitizeTerminalLine(task.command),
              style: (text: string) => theme.fg("dim", text),
            },
          ],
        ]
      : []),
  ];
  return { text: styledFacts(facts, theme), facts, hang: 2 };
}

const separatorStyle =
  (theme: PreviewTheme) =>
  (text: string): string =>
    theme.fg("dim", text);

const styledFacts = (facts: ReadonlyArray<Fact>, theme: PreviewTheme): string =>
  Arr.join(
    Arr.map(facts, (fact) =>
      Arr.join(
        Arr.map(fact, (part) => part.style(part.text)),
        "",
      ),
    ),
    separatorStyle(theme)(INLINE_SEPARATOR),
  );

/** A part's visible characters, each with the part's style. */
const visibleChars = (part: Styled) =>
  Arr.filterMap(Array.from(part.text), (char) =>
    Str.trim(char) === "" ? Result.failVoid : Result.succeed({ char, style: part.style }),
  );

/**
 * Wraps facts with `wrapFacts`, which keeps each fact whole where it fits, then styles every part of
 * each line as the fact it came from. Wrapping only adds spaces and drops the separators where it
 * breaks, so each visible character still matches the next one of the facts.
 */
function wrapStyledFacts(
  facts: ReadonlyArray<Fact>,
  width: number,
  hang: number,
  theme: PreviewTheme,
): string[] {
  const separator = separatorStyle(theme);
  const styled = Arr.flatMap(facts, (fact, index) => [
    ...(index > 0 ? visibleChars({ text: INLINE_SEPARATOR, style: separator }) : []),
    ...Arr.flatMap(fact, visibleChars),
  ]);
  const plain = Arr.join(
    Arr.map(facts, (fact) =>
      Arr.join(
        Arr.map(fact, (part) => part.text),
        "",
      ),
    ),
    INLINE_SEPARATOR,
  );
  let next = 0;
  const styleOf = (char: string) => {
    while (next < styled.length && styled[next]?.char !== char) next++;
    return styled[next++]?.style;
  };
  return Arr.map(wrapFacts(plain, width, Str.repeat(hang)(" ")), (line) => {
    let out = "";
    let run = "";
    let runStyle: ((text: string) => string) | undefined;
    for (const char of Array.from(line)) {
      // A space keeps the style around it; only leading indentation stays unstyled.
      const style = Str.trim(char) === "" ? runStyle : styleOf(char);
      if (style !== runStyle) {
        out += runStyle ? runStyle(run) : run;
        run = "";
        runStyle = style;
      }
      run += char;
    }
    return out + (runStyle ? runStyle(run) : run);
  });
}

/**
 * A stand-in for rows a collapsed preview hides, where they would be, naming what expansion reveals:
 * `▸ 18 more lines · C-o Expand`.
 */
const hiddenRows = (label: string, theme: PreviewTheme): Row => ({
  text: renderExpansionAffordance(label, false, theme),
});

/** The first and last lines, with the count of those between where they're left out. */
function boundedLines(lines: ReadonlyArray<string>, theme: PreviewTheme): Row[] {
  const shown = LOG_HEAD_LINES + LOG_TAIL_LINES;
  const text = (line: string): Row => ({ text: styledTaskOutputLine(line, theme) });
  if (lines.length <= shown) return Arr.map(lines, text);
  return [
    ...Arr.map(lines.slice(0, LOG_HEAD_LINES), text),
    hiddenRows(countLabel(lines.length - shown, "more line"), theme),
    ...Arr.map(lines.slice(-LOG_TAIL_LINES), text),
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
    taskPreviewRow(task, theme, {
      inHeading: false,
      expanded: expanded && !issues,
      issuesBeneath: issues,
    }),
    ...(issues ? taskIssueRows(task, theme) : []),
  ]);
  const hidden = tasks.slice(shown.length);
  if (hidden.length > 0) {
    // A hidden failure is named, so a collapsed listing never hides one silently.
    const { failed } = countTaskStates(hidden);
    rows.push(
      hiddenRows(
        joinInline([
          countLabel(hidden.length, "more task"),
          ...(failed ? [`${failed} failed`] : []),
        ]),
        theme,
      ),
    );
  }
  return rows;
}

const COLLAPSED_TAIL_LINES = 4;

const outputLines = (text: string): string[] =>
  Str.split(Fn.pipe(text, Str.replace(/\n+$/u, "")), "\n");

/** The last few lines of a finished task's output, collapsed; expansion shows the full result. */
function tailRows(tail: string | undefined, theme: PreviewTheme): Row[] {
  const lines = tail ? outputLines(tail) : [];
  if (lines.length === 0) return [];
  const shown = lines.slice(-COLLAPSED_TAIL_LINES);
  const earlier = lines.length - shown.length;
  return [
    ...(earlier > 0 ? [hiddenRows(countLabel(earlier, "earlier line"), theme)] : []),
    ...Arr.map(shown, (line) => ({ text: styledTaskOutputLine(line, theme) })),
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
    taskPreviewRow(wait.snapshot, theme, { inHeading: true, expanded: false }),
    ...foundRows(wait, theme),
    // Expansion shows the whole tail.
    ...(wait.outcome === "completed" ? tailRows(wait.tail, theme) : []),
  ];
}

// `stop all` stops the active tasks, so an empty one reads like an empty active listing.
const emptyListLabel = (state: string | undefined): string =>
  Str.capitalize(emptyTaskListLabel(state));

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
    : boundedLines(lines, theme);
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
      return [taskPreviewRow(details.snapshot, theme, { ...options, started: true })];
    case "status":
      return [taskPreviewRow(details.snapshot, theme, options)];
    case "stop":
      return [
        taskPreviewRow(details.snapshot, theme, options),
        ...(details.alreadyFinished
          ? [{ text: theme.fg("muted", "Already finished; nothing was stopped") }]
          : []),
      ];
    case "wait":
      return waitRows(details, theme);
    case "list":
      return taskRows(details.tasks, emptyListLabel(args.state), false, theme);
    case "stop_all":
      return taskRows(details.tasks, emptyListLabel("active"), false, theme);
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
            rows: [taskPreviewRow(task, theme, { inHeading: true, expanded: true, started })],
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
    // A compact heading already says a listing is empty.
    case "list":
      return headingShowsState && details.tasks.length === 0
        ? []
        : [
            {
              label: "Tasks",
              rows: taskRows(details.tasks, emptyListLabel(args.state), true, theme, true),
            },
          ];
    case "stop_all":
      return headingShowsState && details.tasks.length === 0
        ? []
        : [
            {
              label: "Tasks",
              rows: taskRows(details.tasks, emptyListLabel("active"), true, theme),
            },
          ];
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
    return [{ rows: boundedLines(outputLines(text), theme) }];
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

function rowsComponent(rows: ReadonlyArray<Row>, theme: PreviewTheme): Component {
  let cached: { readonly width: number; readonly lines: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.lines;
      const lines = Arr.flatMap(rows, (row) =>
        row.wrap
          ? row.facts !== undefined
            ? wrapStyledFacts(row.facts, width, row.hang ?? 2, theme)
            : row.hang === undefined
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
    const rows = rowsComponent(section.rows, theme);
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
