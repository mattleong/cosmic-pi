import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { isQuestionnaireComplete } from "../questionnaire/reducer.ts";
import type { QuestionDraft, QuestionnaireState } from "../questionnaire/model.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserQuestion,
} from "../questionnaire/schema.ts";
import type { PreviewPane } from "./preview-pane.ts";
import { RESUME_HINT } from "../boundary/host-ui.ts";
import {
  appendPacked,
  appendHintBar,
  appendWrapped,
  borderLine,
  joinColumns,
  titleLabel,
} from "./layout.ts";
import type { EditorKeyLabels } from "./key-hints.ts";
import { SELECTION_MARKER } from "./viewport.ts";
import { clipToWidth, managerNoticeColor, managerNoticeGlyph } from "pi-cosmic-ui/manager";
import { keyHint, keyHintBar, keyRangeLabel, moveKeyHint } from "pi-cosmic-ui/manager/key-labels";
import { LIST_CURSOR, selectionMarker } from "pi-cosmic-ui/manager/style";
import { formatCount } from "pi-cosmic-core/display";

export interface DialogInputMode {
  readonly kind: "custom" | "text" | "note";
  readonly question: number;
}

interface QuestionnaireRenderModel {
  readonly theme: Theme;
  readonly state: QuestionnaireState;
  readonly input: DialogInputMode | undefined;
  readonly inputError: string | undefined;
  readonly alternateHelp: boolean;
  readonly externalEditorBusy: boolean;
  readonly keys: EditorKeyLabels;
  readonly editor: Editor;
  readonly preview: PreviewPane;
}

/** One question needs no tabs, progress, or review: answering it submits the questionnaire. */
export const isSingleQuestion = (state: QuestionnaireState): boolean =>
  state.request.questions.length === 1;

// Answered tabs carry the suite's done mark; unanswered ones stay unmarked rather than borrowing
// the queued glyph, and Review has no mark until it is the current tab.
function renderTabs(model: QuestionnaireRenderModel, width: number): string[] {
  const parts = Arr.map(model.state.request.questions, (question, index) => {
    const answered = model.state.drafts[index]?.answer !== undefined;
    const label = titleLabel(question.title);
    if (index === model.state.currentTab)
      return model.theme.bg(
        "selectedBg",
        model.theme.fg("text", ` ${answered ? "✓ " : ""}${label} `),
      );
    return answered
      ? ` ${model.theme.fg("success", "✓")} ${model.theme.fg("muted", label)} `
      : model.theme.fg("muted", ` ${label} `);
  });
  const review = " Review ";
  parts.push(
    model.state.currentTab === model.state.request.questions.length
      ? model.theme.bg("selectedBg", model.theme.fg("text", review))
      : model.theme.fg(isQuestionnaireComplete(model.state) ? "accent" : "dim", review),
  );
  const lines: string[] = [];
  appendPacked(lines, parts, width, { separator: " ", prefix: " ", continuation: " " });
  return lines;
}

function renderProgress(model: QuestionnaireRenderModel, width: number): string[] {
  const lines: string[] = [];
  const total = model.state.request.questions.length;
  const answered = Arr.filter(model.state.drafts, (draft) => draft.answer !== undefined).length;
  const text =
    model.state.currentTab === total
      ? `${answered} of ${total} answered`
      : `Question ${model.state.currentTab + 1} of ${total} · ${answered} of ${total} answered`;
  appendWrapped(lines, " ", model.theme.fg("dim", text), width);
  return lines;
}

function renderHeading(model: QuestionnaireRenderModel, width: number): string[] {
  if (!isSingleQuestion(model.state))
    return [...renderTabs(model, width), ...renderProgress(model, width)];
  const [question] = model.state.request.questions;
  const lines: string[] = [];
  if (question)
    appendWrapped(
      lines,
      " ",
      model.theme.fg("accent", model.theme.bold(titleLabel(question.title))),
      width,
    );
  return lines;
}

/** Every question prompt, and the note editor's heading in its place, reads the same way. */
const promptText = (model: QuestionnaireRenderModel, text: string): string =>
  model.theme.fg("text", text);

function focusPrefix(model: QuestionnaireRenderModel, focused: boolean): string {
  return focused ? SELECTION_MARKER + model.theme.fg("accent", `${LIST_CURSOR} `) : "  ";
}

const choiceMarker = (question: AskUserQuestion, selected: boolean): string =>
  selectionMarker(question.mode === "multiple" ? "multiple" : "single", selected);

type AppendLine = (prefix: string, value: string, hang?: number) => void;

function appendChoices(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft,
  append: AppendLine,
): void {
  const choices = question.mode === "text" ? [] : question.choices;
  Arr.forEach(choices, (choice, index) => {
    const focused = draft.cursor === index;
    const selected = draft.answer?.kind === "choices" && draft.answer.values.includes(choice.value);
    const marker = `${choiceMarker(question, selected)} ${index + 1}. `;
    append(
      focusPrefix(model, focused),
      model.theme.fg(
        focused ? "accent" : "text",
        `${marker}${stripTerminalControls(choice.label)}`,
      ),
      visibleWidth(marker),
    );
    append("      ", model.theme.fg("muted", stripTerminalControls(choice.description)));
  });
}

function appendCustomRow(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft,
  append: AppendLine,
): void {
  const focused = draft.cursor === (question.mode === "text" ? 0 : question.choices.length);
  const written = draft.answer?.kind === "custom" || draft.answer?.kind === "text";
  const custom = written ? ` — ${clipToWidth(stripTerminalControls(draft.answer.text), 48)}` : "";
  const label =
    question.mode === "text"
      ? written
        ? "Edit answer"
        : "Write an answer"
      : written
        ? "Edit custom answer"
        : "Write a custom answer";
  append(
    focusPrefix(model, focused),
    model.theme.fg(focused ? "accent" : "text", `✎ ${label}${custom}`),
    2,
  );
}

function appendContinueRow(
  model: QuestionnaireRenderModel,
  choiceCount: number,
  draft: QuestionDraft,
  append: AppendLine,
): void {
  const focused = draft.cursor === choiceCount + 1;
  const selectedCount = draft.answer?.kind === "choices" ? draft.answer.values.length : 0;
  const action = isSingleQuestion(model.state) ? "Submit" : "Continue";
  const label =
    draft.answer?.kind === "custom"
      ? `${action} (custom answer)`
      : `${action} (${selectedCount} selected)`;
  const color = !draft.answer ? "dim" : focused ? "accent" : "success";
  append(focusPrefix(model, focused), model.theme.fg(color, label));
}

function renderQuestion(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft,
  width: number,
): string[] {
  const lines: string[] = [];
  const append: AppendLine = (prefix, value, hang) =>
    appendWrapped(lines, prefix, value, width, hang);
  append(" ", promptText(model, stripTerminalControls(question.prompt)));
  lines.push("");
  appendChoices(model, question, draft, append);
  appendCustomRow(model, question, draft, append);
  if (question.mode === "multiple")
    appendContinueRow(model, question.choices.length, draft, append);
  // An action row, as the suite writes them: its one key in brackets, then what it does.
  const note = draft.note
    ? `Edit note — ${clipToWidth(stripTerminalControls(draft.note), 48)}`
    : "Add a note";
  append(
    "  ",
    `${model.theme.fg("dim", "[n]")} ${model.theme.fg(draft.note ? "muted" : "dim", note)}`,
    4,
  );
  return lines;
}

function renderReview(model: QuestionnaireRenderModel, width: number): string[] {
  const lines: string[] = [];
  const append: AppendLine = (prefix, value, hang) =>
    appendWrapped(lines, prefix, value, width, hang);
  Arr.forEach(model.state.request.questions, (question, index) => {
    const draft = model.state.drafts[index];
    const answer = draft?.answer;
    const value =
      answer?.kind === "choices" && question.mode !== "text"
        ? Arr.join(
            Arr.map(
              Arr.filter(question.choices, (choice) => answer.values.includes(choice.value)),
              (choice) => choice.label,
            ),
            ", ",
          )
        : answer?.kind === "custom" || answer?.kind === "text"
          ? answer.text
          : "Unanswered";
    // An unanswered question awaits the user's decision; it is not a problem.
    const mark = answer ? "success" : "attention";
    const tone = managerNoticeColor(mark);
    append(
      " ",
      `${model.theme.fg(tone, `${managerNoticeGlyph(mark)} `)}${model.theme.fg(answer ? "muted" : tone, `${titleLabel(question.title)}: `)}${model.theme.fg(answer ? "text" : tone, stripTerminalControls(value))}`,
      2,
    );
    if (draft?.note)
      append("   ", model.theme.fg("dim", `Note: ${stripTerminalControls(draft.note)}`));
  });
  lines.push("");
  const complete = isQuestionnaireComplete(model.state);
  const actions = [complete ? "Submit answers" : "Answer next question", "Cancel"];
  Arr.forEach(actions, (action, index) => {
    const focused = model.state.reviewCursor === index;
    append(focusPrefix(model, focused), model.theme.fg(focused ? "accent" : "text", action));
  });
  return lines;
}

function renderInput(
  model: QuestionnaireRenderModel,
  input: DialogInputMode,
  question: AskUserQuestion,
  width: number,
): string[] {
  const lines: string[] = [];
  const append = (prefix: string, value: string) => appendWrapped(lines, prefix, value, width);
  const note = input.kind === "note";
  append(
    " ",
    promptText(
      model,
      note ? `Note for ${titleLabel(question.title)}` : stripTerminalControls(question.prompt),
    ),
  );
  lines.push(...model.editor.render(width));
  const maximum = note ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
  const characterCount = Str.trim(model.editor.getExpandedText()).length;
  append(
    " ",
    model.theme.fg(
      characterCount >= maximum * 0.9 ? "warning" : "dim",
      `${formatCount(characterCount)} / ${formatCount(maximum)} characters`,
    ),
  );
  if (model.externalEditorBusy) append(" ", model.theme.fg("warning", "External editor is open…"));
  if (model.inputError) append(" ", model.theme.fg("warning", model.inputError));
  return lines;
}

function inputHelp(model: QuestionnaireRenderModel, note: boolean): string {
  const { submit, newLine, externalEditor } = model.keys;
  const commit = !note && isSingleQuestion(model.state) ? "Submit" : "Save";
  return keyHintBar(
    {
      hints: [
        keyHint(submit, commit),
        newLine && keyHint(newLine, "Newline"),
        externalEditor && keyHint(externalEditor, "Editor"),
      ],
      exit: "nested",
    },
    false,
  );
}

function renderQuestionPane(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft,
  width: number,
): string[] {
  const choices = question.mode === "text" ? [] : question.choices;
  const choice = choices[draft.cursor];
  model.preview.setChoice(choice?.preview ? choice : undefined);
  const hasAnyPreview = Arr.some(
    choices,
    (candidate) => candidate.preview !== undefined && candidate.preview !== "",
  );
  const lines: string[] = [];
  if (hasAnyPreview && width >= 92) {
    const leftWidth = Math.max(36, Math.floor(width * 0.48));
    const rightWidth = Math.max(8, width - leftWidth - 2);
    lines.push(
      ...joinColumns(
        renderQuestion(model, question, draft, leftWidth),
        model.preview.render(rightWidth),
        leftWidth,
        rightWidth,
      ),
    );
  } else {
    lines.push(...renderQuestion(model, question, draft, width));
    if (hasAnyPreview) lines.push("", ...model.preview.render(width));
  }
  if (model.inputError)
    appendWrapped(lines, " ", model.theme.fg("warning", model.inputError), width);
  return lines;
}

type FocusedRow = "choice" | "custom" | "continue" | "text";

function focusedRow(question: AskUserQuestion, draft: QuestionDraft | undefined): FocusedRow {
  if (question.mode === "text") return "text";
  const cursor = draft?.cursor ?? 0;
  if (cursor < question.choices.length) return "choice";
  return cursor === question.choices.length ? "custom" : "continue";
}

function enterVerb(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft | undefined,
): string | undefined {
  const single = isSingleQuestion(model.state);
  const written = draft?.answer?.kind === "custom" || draft?.answer?.kind === "text";
  const row = focusedRow(question, draft);
  // Multiple-choice rows toggle; Space is the advertised key and Enter an alias.
  if (row === "choice") {
    if (question.mode === "multiple") return undefined;
    return single ? "Choose & Submit" : "Choose";
  }
  if (row === "continue") return single ? "Submit" : "Continue";
  return written ? "Edit" : "Write";
}

interface HintSet {
  readonly hints: string[];
  readonly more: string[];
}

function questionHints(model: QuestionnaireRenderModel, question: AskUserQuestion): HintSet {
  const draft = model.state.drafts[model.state.currentTab];
  const single = isSingleQuestion(model.state);
  const toggles = question.mode === "multiple" && focusedRow(question, draft) === "choice";
  const verb = enterVerb(model, question, draft);
  const choices = question.mode === "text" ? undefined : question.choices.length;
  return {
    hints: [
      ...(choices === undefined ? [] : [moveKeyHint()]),
      ...(toggles ? [keyHint("Space", "Toggle")] : []),
      ...(verb ? [keyHint("Enter", verb)] : []),
    ],
    more: [
      ...(toggles ? [keyHint("Enter", "Toggle")] : []),
      ...(choices === undefined
        ? []
        : [
            keyHint(
              keyRangeLabel(1, choices),
              question.mode === "multiple" ? "Toggle" : single ? "Choose & Submit" : "Choose",
            ),
            keyHint("j/k", "Move"),
          ]),
      keyHint("n", "Note"),
    ],
  };
}

function reviewHints(model: QuestionnaireRenderModel): HintSet {
  const verb =
    model.state.reviewCursor === 1
      ? "Cancel"
      : isQuestionnaireComplete(model.state)
        ? "Submit"
        : "Answer";
  return { hints: [moveKeyHint(), keyHint("Enter", verb)], more: [keyHint("j/k", "Move")] };
}

/** Default hints stay first; `?` appends aliases and secondary keys rather than replacing them. */
function navigationHelp(model: QuestionnaireRenderModel): string {
  const question = model.state.request.questions[model.state.currentTab];
  const { hints, more } = question ? questionHints(model, question) : reviewHints(model);
  const tabs = !isSingleQuestion(model.state);
  return keyHintBar(
    {
      hints: [...hints, tabs && keyHint("←→", "Switch")],
      more: [
        ...more,
        tabs && keyHint("Tab/⇧Tab/h/l", "Switch"),
        keyHint("b", `Hide (${RESUME_HINT})`),
        keyHint("PgUp/PgDn", "Scroll"),
        keyHint("Home/End", "Jump"),
      ],
      exit: "decision",
    },
    model.alternateHelp,
  );
}

function renderBody(model: QuestionnaireRenderModel, width: number): string[] {
  if (model.input) {
    const question = model.state.request.questions[model.input.question];
    return question ? renderInput(model, model.input, question, width) : [];
  }
  const question = model.state.request.questions[model.state.currentTab];
  const draft = model.state.drafts[model.state.currentTab];
  return question && draft
    ? renderQuestionPane(model, question, draft, width)
    : renderReview(model, width);
}

export function renderQuestionnaireView(model: QuestionnaireRenderModel, width: number): string[] {
  const lines = [
    borderLine(width, model.theme),
    ...renderHeading(model, width),
    "",
    ...renderBody(model, width),
    "",
  ];
  // One hint line, in the same place whether the user is choosing or writing.
  const help = model.input ? inputHelp(model, model.input.kind === "note") : navigationHelp(model);
  appendHintBar(lines, help, width, (text) => model.theme.fg("dim", text));
  lines.push(borderLine(width, model.theme));
  return lines;
}
