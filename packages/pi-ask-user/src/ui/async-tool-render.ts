import type {
  AgentToolResult,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import {
  expandedSection,
  withCodePreviewMessageShell,
  type CodePreviewMessagePresenter,
} from "pi-code-previews";
import { INLINE_SEPARATOR, SUITE_STATUS_GLYPHS, wrapFacts } from "pi-cosmic-ui/manager";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core/display";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { composeToolComponent, toolRunningLine } from "pi-cosmic-ui/tool";
import type { PendingPresentation } from "../questionnaire/async-model.ts";
import {
  answerInCompactHeading,
  answersBody,
  answersHideMore,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  markReported,
  mutedState,
  queuedState,
  waitingState,
  stacked,
  type QuestionnaireArgs,
  type RenderContext,
} from "./tool-body.ts";
import {
  answerOutcome,
  callTitles,
  decodeAsyncControl,
  decodeAsyncRows,
  decodePresentation,
  contentText,
  deliveryFacts,
  headingAnswer,
  isStatusList,
  requestFacts,
  isPendingState,
  questionnaireState,
  requestArguments,
  stateCounts,
  stateWords,
  storedTitlesLabel,
  titlesOf,
  type QuestionnaireState,
  type ReplayedAnswer,
  type ReplayedSnapshot,
} from "./tool-render-projection.ts";

const envelope = decodeUnknownOrUndefined(
  Schema.Struct({
    details: Schema.optional(Schema.Unknown),
    content: Schema.optional(Schema.Unknown),
  }),
);
const notification = decodeUnknownOrUndefined(
  Schema.Struct({
    requestId: Schema.String,
    deliveryId: Schema.String,
    generation: Schema.String,
    outcome: answerOutcome,
    titles: Schema.optional(Schema.Unknown),
  }),
);
const NO_TITLES: ReadonlyMap<string, string> = new Map();

type ResultContext = Partial<Pick<RenderContext, "args" | "isError" | "state">>;

type AsyncToolResult = Pick<AgentToolResult<unknown>, "content" | "details">;

export function renderAsyncCall(
  args: QuestionnaireArgs,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state" | "isPartial" | "executionStarted">,
  isControl = false,
): Component {
  const header = isControl
    ? { title: "Questionnaire", subtitle: decodeAsyncControl(args)?.action }
    : { title: "Ask user", subtitle: callTitles(args) };
  return callBody(header, args, theme, context);
}

/** Titles label a lone row's answers; a list shows no answers. */
const rowTitles = (rows: readonly ReplayedSnapshot[] | undefined): ReadonlyMap<string, string> => {
  const [row] = rows ?? [];
  return rows?.length === 1 && row ? titlesOf(row.titles) : NO_TITLES;
};

function submittedAnswers(
  rows: readonly ReplayedSnapshot[] | undefined,
): readonly ReplayedAnswer[] | undefined {
  const [row] = rows ?? [];
  return rows?.length === 1 &&
    row &&
    questionnaireState(row) === "answered" &&
    row.outcome?.outcome === "submitted"
    ? row.outcome.answers
    : undefined;
}

/** How each listed questionnaire's glyph marks its state, as Activity marks them. */
const LISTED_GLYPHS = {
  waiting: { glyph: SUITE_STATUS_GLYPHS.waiting, color: "accent", says: false },
  hidden: { glyph: SUITE_STATUS_GLYPHS.waiting, color: "accent", says: false },
  queued: { glyph: SUITE_STATUS_GLYPHS.queued, color: "muted", says: true },
  answered: { glyph: SUITE_STATUS_GLYPHS.succeeded, color: "success", says: false },
  cancelled: { glyph: SUITE_STATUS_GLYPHS.stopped, color: "muted", says: true },
  failed: { glyph: SUITE_STATUS_GLYPHS.failed, color: "error", says: true },
} as const satisfies Record<
  QuestionnaireState,
  { readonly glyph: string; readonly color: ThemeColor; readonly says: boolean }
>;

/**
 * A list's questionnaires, one glyph-led row each, named by their titles, with the state its glyph
 * doesn't already say: `? Colour · needs your input`, `⊘ Scope`.
 */
function questionnaireList(rows: readonly ReplayedSnapshot[], theme: Theme): Component {
  const entries = Arr.map(rows, (row) => {
    const state = questionnaireState(row);
    const mark = state === undefined ? undefined : LISTED_GLYPHS[state];
    const name = theme.fg("toolOutput", storedTitlesLabel(row.titles) ?? row.requestId);
    const words =
      state === undefined || mark?.says
        ? []
        : Arr.map(stateWords(state), (word) => theme.fg("muted", word));
    const lead = mark ? `${theme.fg(mark.color, mark.glyph)} ` : "";
    return `${lead}${Arr.join([name, ...words], theme.fg("dim", INLINE_SEPARATOR))}`;
  });
  return expandedSection(
    theme,
    "Questionnaires",
    composeToolComponent((width) =>
      width < 1 ? [] : Arr.flatMap(entries, (entry) => wrapFacts(entry, width, "  ")),
    ),
  );
}

export function renderAsyncContent(
  input: AsyncToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ResultContext = {},
): Component {
  const result = envelope(input);
  const rows = decodeAsyncRows(result?.details);
  const list = rows?.length !== 1 || isStatusList(context.args);
  const answers = submittedAnswers(rows);
  return expandedResult(
    {
      raw: contentText(result?.content),
      isError: context.isError ?? false,
      decoded: rows !== undefined,
      answers,
      ...(answers && { answerInHeading: answerInCompactHeading(answers, context) }),
      titles: rowTitles(rows),
      listing: rows && list && rows.length > 0 ? questionnaireList(rows, theme) : undefined,
      facts: rows ? requestFacts(rows, list) : [],
      // The call still shows the request until the final result arrives.
      ...(!options.isPartial && { args: requestArguments(context.args) }),
    },
    theme,
  );
}

export function renderAsyncResult(
  input: AsyncToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ResultContext = {},
): Component {
  markReported(context);
  if (options.isPartial)
    return presentationLine(decodePresentation(envelope(input)?.details), theme);
  const result = envelope(input);
  const decoded = decodeAsyncRows(result?.details);
  const rows = decoded ?? [];
  const states = Arr.getSomes(
    Arr.map(rows, (row) => Option.fromNullishOr(questionnaireState(row))),
  );
  const list = rows.length !== 1 || isStatusList(context.args);
  const classified = decoded !== undefined && states.length === rows.length;
  if (options.expanded) {
    const content = renderAsyncContent(input, options, theme, context);
    // A list keeps its counts and a lone cancellation its line; expanded issues state pending work.
    if (context.isError || !classified || (!list && states[0] !== "cancelled")) return content;
    return stacked([collapsedRows(rows, states, list, theme), content]);
  }
  if (context.isError) return emptyBody();
  if (!classified) return new Text(contentText(result?.content), 0, 0);
  const state: unknown = context.state;
  return collapsedRows(rows, states, list, theme, state === undefined ? undefined : { state });
}

/**
 * A live call's line: an await says where its questionnaire stands, as its compact row does, and
 * spins only until it knows. A hidden one's issue already says so and how to resume it.
 */
function presentationLine(presentation: PendingPresentation | undefined, theme: Theme): Component {
  if (presentation === "open") return waitingState(stateWords("waiting"), theme);
  if (presentation === "hidden") return emptyBody();
  if (presentation === "queued") return queuedState(stateWords("queued"), theme);
  return new Text(toolRunningLine(theme), 0, 0);
}

function collapsedRows(
  rows: readonly ReplayedSnapshot[],
  states: readonly QuestionnaireState[],
  list: boolean,
  theme: Theme,
  row?: { readonly state: unknown },
): Component {
  if (rows.length === 0) return mutedState(["No questionnaires", "None"], theme);
  // An open questionnaire needs the user now; a queued one only waits its turn.
  const pendingState = (alternatives: readonly string[], shown = states) =>
    shown.includes("waiting") || shown.includes("hidden")
      ? waitingState(alternatives, theme)
      : shown.includes("queued")
        ? queuedState(alternatives, theme)
        : mutedState(alternatives, theme);
  if (list) {
    // Hidden and failed questionnaires have their own issues: how to resume them, and the failure.
    const counted = Arr.filter(states, (entry) => entry !== "hidden" && entry !== "failed");
    return counted.length === 0
      ? emptyBody()
      : pendingState(stateCounts(counted, counted.length < states.length), counted);
  }
  const [state] = states;
  if (state === "cancelled") return cancelledLine(theme);
  // Its issue says it is hidden and how to resume it.
  if (state === "hidden") return emptyBody();
  const answers = submittedAnswers(rows);
  if (answers) return answersBody(answers, rowTitles(rows), theme, row);
  return state && isPendingState(state) ? pendingState(stateWords(state)) : emptyBody();
}

/**
 * An async questionnaire's answer message: what happened as its heading, then the answers. A
 * message whose details don't decode keeps its stored text.
 */
export const presentAsyncMessage: CodePreviewMessagePresenter = (input, options, theme) => {
  const message = envelope(input);
  const delivered = notification(message?.details);
  const outcome = delivered?.outcome;
  const titles = titlesOf(delivered?.titles);
  const raw = contentText(message?.content);
  const answers = outcome?.outcome === "submitted" ? outcome.answers : undefined;
  const preview = options.collapsedStyle === "preview";
  const expanded = () =>
    expandedResult(
      {
        raw,
        isError: false,
        decoded: delivered !== undefined,
        answers,
        // A compact heading carries a lone short answer, so its body leaves it out.
        answerInHeading: () =>
          !preview && answers !== undefined && headingAnswer(answers) !== undefined,
        titles,
        facts: delivered ? deliveryFacts(delivered.requestId, delivered.deliveryId) : [],
      },
      theme,
    );
  // The icon says whether it was answered or cancelled; the heading names the questions.
  const subject = storedTitlesLabel(delivered?.titles) ?? "questionnaire";
  const presentation = { name: "ask_user_answers", label: "Answers", expanded };
  // A preview body already shows the stored text that expansion would.
  if (!outcome)
    return {
      ...presentation,
      summary: { subject },
      ...(preview ? { collapsed: () => new Text(raw, 0, 0) } : { expandLabel: "message" }),
    };
  const cancelled = outcome.outcome === "cancelled";
  // The preview heading carries no glyph, so its body names the cancellation.
  const cancellation = preview && cancelled;
  // A compact heading carries a lone short answer itself, `✓ ask_user_answers Colour · red`, and
  // then expanding shows only the request and delivery IDs; it counts other answers, which
  // expansion shows. A preview body shows the answers beneath a count.
  const lone = !preview && answers ? headingAnswer(answers) : undefined;
  return {
    ...presentation,
    summary: {
      subject,
      outcome: cancelled ? "cancelled" : "success",
      // An answer is a fact about the questions, so it stays even where it is a word the glyph says.
      ...(lone === undefined
        ? { counters: answers?.length ? [countLabel(answers.length, "answer")] : [] }
        : { counters: [lone], subjectState: true }),
    },
    // The answers' hidden lines, else the request and delivery IDs.
    expandLabel:
      answers && lone === undefined && (!preview || answersHideMore(answers))
        ? "answers"
        : "details",
    // The heading names the questions, so a lone answer may leave its title to it.
    ...(answers && {
      collapsed: (headingState: WeakKey) =>
        answersBody(answers, titles, theme, undefined, headingState),
    }),
    ...(cancellation && {
      collapsed: () => cancelledLine(theme),
      expanded: () => stacked([cancelledLine(theme), expanded()]),
    }),
  };
};

export const renderAsyncMessage = withCodePreviewMessageShell(presentAsyncMessage);
