import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, truncateToWidth } from "@earendil-works/pi-tui";
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

export interface DialogInputMode {
  readonly kind: "custom" | "note";
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

function renderQuestion(
  model: QuestionnaireRenderModel,
  question: AskUserQuestion,
  width: number,
): string[] {
  const lines: string[] = [];
  const append = (prefix: string, value: string) => appendWrapped(lines, prefix, value, width);
  const draft = model.state.drafts[model.state.currentTab]!;
  append(" ", model.theme.fg("text", stripTerminalControls(question.prompt)));
  lines.push("");
  for (let index = 0; index < question.choices.length; index++) {
    const choice = question.choices[index]!;
    const focused = draft.cursor === index;
    const selected = draft.answer?.kind === "choices" && draft.answer.values.includes(choice.value);
    const marker =
      question.mode === "multiple" ? `[${selected ? "x" : " "}]` : selected ? "[●]" : "[ ]";
    append(
      focused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(
        focused ? "accent" : "text",
        `${marker} ${index + 1}. ${stripTerminalControls(choice.label)}`,
      ),
    );
    append("      ", model.theme.fg("muted", stripTerminalControls(choice.description)));
  }
  const customIndex = question.choices.length;
  const customFocused = draft.cursor === customIndex;
  const custom =
    draft.answer?.kind === "custom"
      ? ` — ${truncateToWidth(stripTerminalControls(draft.answer.text), 48)}`
      : "";
  append(
    customFocused ? model.theme.fg("accent", "> ") : "  ",
    model.theme.fg(customFocused ? "accent" : "text", `✎ Write a custom answer${custom}`),
  );
  if (question.mode === "multiple") {
    const continueFocused = draft.cursor === customIndex + 1;
    const selectedCount = draft.answer?.kind === "choices" ? draft.answer.values.length : undefined;
    const continueLabel =
      draft.answer?.kind === "custom"
        ? "→ Continue (custom answer)"
        : `→ Continue (${selectedCount ?? 0} selected)`;
    append(
      continueFocused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(
        draft.answer ? (continueFocused ? "accent" : "success") : "dim",
        continueLabel,
      ),
    );
  }
  const note = draft.note
    ? `n Edit note — ${truncateToWidth(stripTerminalControls(draft.note), 48)}`
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
      answer?.kind === "choices"
        ? answer.labels.join(", ")
        : answer?.kind === "custom"
          ? answer.text
          : "Unanswered";
    append(
      " ",
      `${model.theme.fg(answer ? "success" : "warning", answer ? "✓ " : "! ")}${model.theme.fg(answer ? "muted" : "warning", `${stripTerminalControls(question.title)}: `)}${model.theme.fg(answer ? "text" : "warning", stripTerminalControls(value))}`,
    );
    if (draft?.note)
      append("   ", model.theme.fg("dim", `Note: ${stripTerminalControls(draft.note)}`));
  });
  lines.push("");
  const complete = isQuestionnaireComplete(model.state);
  const actions = [complete ? "Submit answers" : "Answer next unanswered", "Cancel"];
  actions.forEach((action, index) => {
    const focused = model.state.reviewCursor === index;
    append(
      focused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(focused ? "accent" : "text", action),
    );
  });
  return lines;
}

export function renderQuestionnaireView(model: QuestionnaireRenderModel, width: number): string[] {
  const lines = [
    borderLine(width, model.theme),
    ...renderTabs(model, width),
    ...renderProgress(model, width),
    "",
  ];
  const append = (prefix: string, value: string) => appendWrapped(lines, prefix, value, width);
  if (model.input) {
    const question = model.state.request.questions[model.input.question]!;
    append(
      " ",
      model.theme.fg(
        "accent",
        model.theme.bold(
          model.input.kind === "note"
            ? `Note for ${stripTerminalControls(question.title)}`
            : stripTerminalControls(question.prompt),
        ),
      ),
    );
    lines.push(...model.editor.render(width));
    const maximum = model.input.kind === "note" ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
    const characterCount = model.editor.getExpandedText().trim().length;
    append(
      " ",
      model.theme.fg(
        characterCount >= maximum * 0.9 ? "warning" : "dim",
        `${characterCount} / ${maximum} characters`,
      ),
    );
    if (model.externalEditorBusy)
      append(" ", model.theme.fg("warning", "External editor is open…"));
    if (model.inputError) append(" ", model.theme.fg("warning", model.inputError));
    append(
      " ",
      model.theme.fg(
        "dim",
        `Enter ${model.input.kind === "note" ? "save note" : "use answer"} • Shift+Enter newline • Esc back • configured external-editor key opens editor`,
      ),
    );
  } else if (model.state.currentTab === model.state.request.questions.length) {
    lines.push(...renderReview(model, width));
  } else {
    const question = model.state.request.questions[model.state.currentTab]!;
    const draft = model.state.drafts[model.state.currentTab]!;
    const choice =
      draft.cursor < question.choices.length ? question.choices[draft.cursor] : undefined;
    model.preview.setChoice(choice?.preview ? choice : undefined);
    const hasAnyPreview = question.choices.some((candidate) => !!candidate.preview);
    if (hasAnyPreview && width >= 92) {
      const leftWidth = Math.max(36, Math.floor(width * 0.48));
      const rightWidth = Math.max(8, width - leftWidth - 2);
      lines.push(
        ...joinColumns(
          renderQuestion(model, question, leftWidth),
          model.preview.render(rightWidth),
          leftWidth,
          rightWidth,
        ),
      );
    } else {
      lines.push(...renderQuestion(model, question, width));
      if (hasAnyPreview) {
        lines.push("");
        lines.push(...model.preview.render(width));
      }
    }
    if (model.inputError) append(" ", model.theme.fg("warning", model.inputError));
  }
  lines.push("");
  if (!model.input) {
    const onReview = model.state.currentTab === model.state.request.questions.length;
    const question = onReview ? undefined : model.state.request.questions[model.state.currentTab];
    const help = model.alternateHelp
      ? "j/k or ↑↓ move • h/l or Tab/←→ questions • n note • b hide (resume from footer) • Esc cancel • ? less"
      : onReview
        ? `↑↓ move • Enter ${isQuestionnaireComplete(model.state) ? "confirm" : "open unanswered"} • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`
        : question?.mode === "multiple"
          ? `1–${question.choices.length} toggle • ↑↓ move • Space toggle • Enter activate • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`
          : `1–${question?.choices.length ?? 0} choose • ↑↓ move • Enter activate • h/l or Tab/←→ questions • b hide • Esc cancel • ? help`;
    append(" ", model.theme.fg("dim", help));
  }
  lines.push(borderLine(width, model.theme));
  return lines.map((line) => truncateToWidth(line, width, ""));
}
