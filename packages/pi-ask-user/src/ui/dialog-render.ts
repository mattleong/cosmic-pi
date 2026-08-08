import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, truncateToWidth } from "@earendil-works/pi-tui";
import { isQuestionnaireComplete } from "../questionnaire/reducer.ts";
import type { QuestionnaireState } from "../questionnaire/model.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserQuestion,
  type AskUserRequest,
} from "../tools/schema.ts";
import type { PreviewPane } from "./components/preview-pane.ts";
import { appendWrapped, borderLine, joinColumns, safeText } from "./render.ts";

export interface DialogInputMode {
  readonly kind: "custom" | "note";
  readonly question: number;
}

export interface QuestionnaireRenderModel {
  readonly theme: Theme;
  readonly request: AskUserRequest;
  readonly state: QuestionnaireState;
  readonly input?: DialogInputMode;
  readonly inputError?: string;
  readonly alternateHelp?: boolean;
  readonly externalEditorBusy: boolean;
  readonly editor: Editor;
  readonly preview: PreviewPane;
}

function renderTabs(model: QuestionnaireRenderModel, width: number): string[] {
  const parts = model.request.questions.map((question, index) => {
    const answered = model.state.drafts[index]?.answer !== undefined;
    const text = ` ${answered ? "●" : "○"} ${safeText(question.title)} `;
    return index === model.state.currentTab
      ? model.theme.bg("selectedBg", model.theme.fg("text", text))
      : model.theme.fg(answered ? "success" : "muted", text);
  });
  const review = " ✓ Review ";
  parts.push(
    model.state.currentTab === model.request.questions.length
      ? model.theme.bg("selectedBg", model.theme.fg("text", review))
      : model.theme.fg(isQuestionnaireComplete(model.state) ? "success" : "dim", review),
  );
  const lines: string[] = [];
  appendWrapped(lines, " ", parts.join(" "), width);
  return lines;
}

function renderProgress(model: QuestionnaireRenderModel, width: number): string[] {
  const lines: string[] = [];
  const total = model.request.questions.length;
  const answered = model.state.drafts.filter((draft) => draft.answer !== undefined).length;
  const text =
    model.state.currentTab === total
      ? `Review • ${answered} of ${total} answered`
      : `Question ${model.state.currentTab + 1} of ${total} • ${answered} of ${total} answered`;
  appendWrapped(lines, " ", model.theme.fg("dim", text), width);
  return lines;
}

function renderQuestion(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  width: number,
): string[] {
  const lines: string[] = [];
  const draft = model.state.drafts[model.state.currentTab]!;
  appendWrapped(lines, " ", model.theme.fg("text", safeText(question.prompt)), width);
  lines.push("");
  for (let index = 0; index < question.choices.length; index++) {
    const choice = question.choices[index]!;
    const focused = draft.cursor === index;
    const selected = draft.answer?.kind === "choices" && draft.answer.values.includes(choice.value);
    const marker =
      question.mode === "multiple" ? `[${selected ? "x" : " "}]` : selected ? "[●]" : "[ ]";
    appendWrapped(
      lines,
      focused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(
        focused ? "accent" : "text",
        `${marker} ${index + 1}. ${safeText(choice.label)}`,
      ),
      width,
    );
    appendWrapped(lines, "      ", model.theme.fg("muted", safeText(choice.description)), width);
  }
  const customIndex = question.choices.length;
  const customFocused = draft.cursor === customIndex;
  const custom =
    draft.answer?.kind === "custom" ? ` — ${truncateToWidth(safeText(draft.answer.text), 48)}` : "";
  appendWrapped(
    lines,
    customFocused ? model.theme.fg("accent", "> ") : "  ",
    model.theme.fg(customFocused ? "accent" : "text", `✎ Write a custom answer${custom}`),
    width,
  );
  if (question.mode === "multiple") {
    const continueFocused = draft.cursor === customIndex + 1;
    const selectedCount = draft.answer?.kind === "choices" ? draft.answer.values.length : undefined;
    const continueLabel =
      draft.answer?.kind === "custom"
        ? "→ Continue (custom answer)"
        : `→ Continue (${selectedCount ?? 0} selected)`;
    appendWrapped(
      lines,
      continueFocused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(
        draft.answer ? (continueFocused ? "accent" : "success") : "dim",
        continueLabel,
      ),
      width,
    );
  }
  const note = draft.note
    ? `n Edit note — ${truncateToWidth(safeText(draft.note), 48)}`
    : "n Add an optional note";
  appendWrapped(lines, "  ", model.theme.fg(draft.note ? "muted" : "dim", note), width);
  return lines;
}

function renderReview(model: QuestionnaireRenderModel, width: number): string[] {
  const lines: string[] = [];
  appendWrapped(
    lines,
    " ",
    model.theme.fg("accent", model.theme.bold("Review your answers")),
    width,
  );
  lines.push("");
  model.request.questions.forEach((question, index) => {
    const draft = model.state.drafts[index];
    const answer = draft?.answer;
    const value =
      answer?.kind === "choices"
        ? answer.labels.join(", ")
        : answer?.kind === "custom"
          ? answer.text
          : "Unanswered";
    appendWrapped(
      lines,
      " ",
      `${model.theme.fg(answer ? "success" : "warning", answer ? "✓ " : "! ")}${model.theme.fg(answer ? "muted" : "warning", `${safeText(question.title)}: `)}${model.theme.fg(answer ? "text" : "warning", safeText(value))}`,
      width,
    );
    if (draft?.note)
      appendWrapped(lines, "   ", model.theme.fg("dim", `Note: ${safeText(draft.note)}`), width);
  });
  lines.push("");
  const complete = isQuestionnaireComplete(model.state);
  const actions = [complete ? "Submit answers" : "Answer next unanswered", "Cancel"];
  actions.forEach((action, index) => {
    const focused = model.state.reviewCursor === index;
    appendWrapped(
      lines,
      focused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(focused ? "accent" : "text", action),
      width,
    );
  });
  return lines;
}

export function renderQuestionnaireView(model: QuestionnaireRenderModel, width: number): string[] {
  const renderWidth = Math.max(1, width);
  const lines = [
    borderLine(renderWidth, model.theme),
    ...renderTabs(model, renderWidth),
    ...renderProgress(model, renderWidth),
    "",
  ];
  if (model.input) {
    const question = model.request.questions[model.input.question]!;
    appendWrapped(
      lines,
      " ",
      model.theme.fg(
        "accent",
        model.theme.bold(
          model.input.kind === "note"
            ? `Note for ${safeText(question.title)}`
            : safeText(question.prompt),
        ),
      ),
      renderWidth,
    );
    lines.push(...model.editor.render(Math.max(1, renderWidth)));
    const maximum = model.input.kind === "note" ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
    const characterCount = model.editor.getExpandedText().trim().length;
    appendWrapped(
      lines,
      " ",
      model.theme.fg(
        characterCount >= maximum * 0.9 ? "warning" : "dim",
        `${characterCount} / ${maximum} characters`,
      ),
      renderWidth,
    );
    if (model.externalEditorBusy)
      appendWrapped(lines, " ", model.theme.fg("warning", "External editor is open…"), renderWidth);
    if (model.inputError)
      appendWrapped(lines, " ", model.theme.fg("warning", model.inputError), renderWidth);
    appendWrapped(
      lines,
      " ",
      model.theme.fg(
        "dim",
        `Enter ${model.input.kind === "note" ? "save note" : "use answer"} • Shift+Enter newline • Esc back • configured external-editor key opens editor`,
      ),
      renderWidth,
    );
  } else if (model.state.currentTab === model.request.questions.length) {
    lines.push(...renderReview(model, renderWidth));
  } else {
    const question = model.request.questions[model.state.currentTab]!;
    const draft = model.state.drafts[model.state.currentTab]!;
    const choice =
      draft.cursor < question.choices.length ? question.choices[draft.cursor] : undefined;
    model.preview.setChoice(choice?.preview ? choice : undefined);
    const hasAnyPreview = question.choices.some((candidate) => !!candidate.preview);
    if (hasAnyPreview && renderWidth >= 92) {
      const leftWidth = Math.max(36, Math.floor(renderWidth * 0.48));
      const rightWidth = Math.max(8, renderWidth - leftWidth - 2);
      lines.push(
        ...joinColumns(
          renderQuestion(model, question, leftWidth),
          model.preview.render(rightWidth),
          leftWidth,
          rightWidth,
        ),
      );
    } else {
      lines.push(...renderQuestion(model, question, renderWidth));
      if (hasAnyPreview) {
        lines.push("");
        lines.push(...model.preview.render(renderWidth));
      }
    }
    if (model.inputError)
      appendWrapped(lines, " ", model.theme.fg("warning", model.inputError), renderWidth);
  }
  lines.push("");
  if (!model.input) {
    const onReview = model.state.currentTab === model.request.questions.length;
    const question = onReview ? undefined : model.request.questions[model.state.currentTab];
    const help = model.alternateHelp
      ? "j/k or ↑↓ move • h/l or Tab/←→ questions • n note • b hide (resume from footer) • Esc cancel • ? less"
      : onReview
        ? `↑↓ move • Enter ${isQuestionnaireComplete(model.state) ? "confirm" : "open unanswered"} • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`
        : question?.mode === "multiple"
          ? `1–${question.choices.length} toggle • ↑↓ move • Space toggle • Enter activate • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`
          : `1–${question?.choices.length ?? 0} choose • ↑↓ move • Enter activate • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`;
    appendWrapped(lines, " ", model.theme.fg("dim", help), renderWidth);
  }
  lines.push(borderLine(renderWidth, model.theme));
  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}
