import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor } from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core";
import { isQuestionnaireComplete } from "../questionnaire/reducer.ts";
import type { QuestionnaireState } from "../questionnaire/model.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserQuestion,
} from "../questionnaire/schema.ts";
import type { PreviewPane } from "./preview-pane.ts";
import { appendWrapped, borderLine, joinColumns } from "./layout.ts";
import { SELECTION_MARKER } from "./viewport.ts";
import { clipToWidth, managerNoticeGlyph } from "pi-cosmic-ui/manager";

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
  readonly editor: Editor;
  readonly preview: PreviewPane;
}

function renderTabs(model: QuestionnaireRenderModel, width: number): string[] {
  const parts = model.state.request.questions.map((question, index) => {
    const answered = model.state.drafts[index]?.answer !== undefined;
    const text = ` ${answered ? "●" : "○"} ${stripTerminalControls(question.title)} `;
    return index === model.state.currentTab
      ? model.theme.bg("selectedBg", model.theme.fg("text", text))
      : model.theme.fg(answered ? "success" : "muted", text);
  });
  const review = " ✓ Review ";
  parts.push(
    model.state.currentTab === model.state.request.questions.length
      ? model.theme.bg("selectedBg", model.theme.fg("text", review))
      : model.theme.fg(isQuestionnaireComplete(model.state) ? "success" : "dim", review),
  );
  const lines: string[] = [];
  appendWrapped(lines, " ", parts.join(" "), width);
  return lines;
}

function renderProgress(model: QuestionnaireRenderModel, width: number): string[] {
  const lines: string[] = [];
  const total = model.state.request.questions.length;
  const answered = model.state.drafts.filter((draft) => draft.answer !== undefined).length;
  const text =
    model.state.currentTab === total
      ? `Review • ${answered} of ${total} answered`
      : `Question ${model.state.currentTab + 1} of ${total} • ${answered} of ${total} answered`;
  appendWrapped(lines, " ", model.theme.fg("dim", text), width);
  return lines;
}

type QuestionDraft = QuestionnaireState["drafts"][number];

function focusPrefix(model: QuestionnaireRenderModel, focused: boolean): string {
  return focused ? SELECTION_MARKER + model.theme.fg("accent", "> ") : "  ";
}

function choiceMarker(question: AskUserQuestion, selected: boolean): string {
  if (question.mode === "multiple") return `[${selected ? "x" : " "}]`;
  return selected ? "[●]" : "[ ]";
}

function appendChoices(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft,
  append: (prefix: string, value: string) => void,
): void {
  const choices = question.mode === "text" ? [] : question.choices;
  choices.forEach((choice, index) => {
    const focused = draft.cursor === index;
    const selected = draft.answer?.kind === "choices" && draft.answer.values.includes(choice.value);
    append(
      focusPrefix(model, focused),
      model.theme.fg(
        focused ? "accent" : "text",
        `${choiceMarker(question, selected)} ${index + 1}. ${stripTerminalControls(choice.label)}`,
      ),
    );
    append("      ", model.theme.fg("muted", stripTerminalControls(choice.description)));
  });
}

function appendCustomRow(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  draft: QuestionDraft,
  append: (prefix: string, value: string) => void,
): void {
  const focused = draft.cursor === (question.mode === "text" ? 0 : question.choices.length);
  const custom =
    draft.answer?.kind === "custom" || draft.answer?.kind === "text"
      ? ` — ${clipToWidth(stripTerminalControls(draft.answer.text), 48)}`
      : "";
  append(
    focusPrefix(model, focused),
    model.theme.fg(
      focused ? "accent" : "text",
      `✎ ${question.mode === "text" ? "Edit answer" : "Write a custom answer"}${custom}`,
    ),
  );
}

function appendContinueRow(
  model: QuestionnaireRenderModel,
  choiceCount: number,
  draft: QuestionDraft,
  append: (prefix: string, value: string) => void,
): void {
  const focused = draft.cursor === choiceCount + 1;
  const selectedCount = draft.answer?.kind === "choices" ? draft.answer.values.length : 0;
  const label =
    draft.answer?.kind === "custom"
      ? "→ Continue (custom answer)"
      : `→ Continue (${selectedCount} selected)`;
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
  const append = (prefix: string, value: string) => appendWrapped(lines, prefix, value, width);
  append(" ", model.theme.fg("text", stripTerminalControls(question.prompt)));
  lines.push("");
  appendChoices(model, question, draft, append);
  appendCustomRow(model, question, draft, append);
  if (question.mode === "multiple")
    appendContinueRow(model, question.choices.length, draft, append);
  const note = draft.note
    ? `n Edit note — ${clipToWidth(stripTerminalControls(draft.note), 48)}`
    : "n Add an optional note";
  append("  ", model.theme.fg(draft.note ? "muted" : "dim", note));
  return lines;
}

function renderReview(model: QuestionnaireRenderModel, width: number): string[] {
  const lines: string[] = [];
  const append = (prefix: string, value: string) => appendWrapped(lines, prefix, value, width);
  append(" ", model.theme.fg("accent", model.theme.bold("Review your answers")));
  lines.push("");
  model.state.request.questions.forEach((question, index) => {
    const draft = model.state.drafts[index];
    const answer = draft?.answer;
    const value =
      answer?.kind === "choices" && question.mode !== "text"
        ? question.choices
            .filter((choice) => answer.values.includes(choice.value))
            .map((choice) => choice.label)
            .join(", ")
        : answer?.kind === "custom" || answer?.kind === "text"
          ? answer.text
          : "Unanswered";
    append(
      " ",
      `${model.theme.fg(answer ? "success" : "warning", answer ? `${managerNoticeGlyph("success")} ` : `${managerNoticeGlyph("warning")} `)}${model.theme.fg(answer ? "muted" : "warning", `${stripTerminalControls(question.title)}: `)}${model.theme.fg(answer ? "text" : "warning", stripTerminalControls(value))}`,
    );
    if (draft?.note)
      append("   ", model.theme.fg("dim", `Note: ${stripTerminalControls(draft.note)}`));
  });
  lines.push("");
  const complete = isQuestionnaireComplete(model.state);
  const actions = [complete ? "Submit answers" : "Answer next question", "Cancel"];
  actions.forEach((action, index) => {
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
    model.theme.fg(
      "accent",
      model.theme.bold(
        note
          ? `Note for ${stripTerminalControls(question.title)}`
          : stripTerminalControls(question.prompt),
      ),
    ),
  );
  lines.push(...model.editor.render(width));
  const maximum = note ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
  const characterCount = model.editor.getExpandedText().trim().length;
  append(
    " ",
    model.theme.fg(
      characterCount >= maximum * 0.9 ? "warning" : "dim",
      `${characterCount} / ${maximum} characters`,
    ),
  );
  if (model.externalEditorBusy) append(" ", model.theme.fg("warning", "External editor is open…"));
  if (model.inputError) append(" ", model.theme.fg("warning", model.inputError));
  append(
    " ",
    model.theme.fg(
      "dim",
      `Enter ${note ? "save note" : "use answer"} • Shift+Enter newline • Esc back • configured external-editor key opens editor`,
    ),
  );
  return lines;
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
  const hasAnyPreview = choices.some(
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

function navigationHelp(model: QuestionnaireRenderModel): string {
  if (model.alternateHelp)
    return "PgUp/PgDn scroll • Home/End first/last • j/k or ↑↓ move • h/l or Tab/←→ questions • n note • b hide (resume from footer) • Esc cancel • ? less";
  const question = model.state.request.questions[model.state.currentTab];
  if (!question)
    return `↑↓ move • Enter ${isQuestionnaireComplete(model.state) ? "confirm" : "open unanswered"} • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`;
  if (question.mode === "text")
    return "Enter edit answer • n note • h/l or Tab/←→ questions • b hide • Esc cancel • ? help";
  if (question.mode === "multiple")
    return `1–${question.choices.length} toggle • ↑↓ move • Space toggle • Enter activate • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`;
  return `1–${question.choices.length} choose • ↑↓ move • Enter activate • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`;
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
    ...renderTabs(model, width),
    ...renderProgress(model, width),
    "",
    ...renderBody(model, width),
    "",
  ];
  if (!model.input) appendWrapped(lines, " ", model.theme.fg("dim", navigationHelp(model)), width);
  lines.push(borderLine(width, model.theme));
  return lines;
}
