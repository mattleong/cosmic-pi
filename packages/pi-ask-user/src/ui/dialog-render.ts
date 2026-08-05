import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Editor, truncateToWidth } from "@earendil-works/pi-tui";
import { isQuestionnaireComplete } from "../questionnaire/reducer.ts";
import type { QuestionnaireState } from "../questionnaire/model.ts";
import type { AskUserQuestion, AskUserRequest } from "../tools/schema.ts";
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
      question.mode === "multiple" ? `[${selected ? "x" : " "}]` : selected ? "(●)" : "( )";
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
    appendWrapped(
      lines,
      continueFocused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(draft.answer ? (continueFocused ? "accent" : "success") : "dim", "→ Continue"),
      width,
    );
  }
  if (draft.note)
    appendWrapped(lines, " ", model.theme.fg("muted", `Note: ${safeText(draft.note)}`), width);
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
      `${model.theme.fg("muted", `${safeText(question.title)}: `)}${model.theme.fg(answer ? "text" : "warning", safeText(value))}`,
      width,
    );
    if (draft?.note)
      appendWrapped(lines, "   ", model.theme.fg("dim", `Note: ${safeText(draft.note)}`), width);
  });
  lines.push("");
  const complete = isQuestionnaireComplete(model.state);
  const actions = [
    { label: "Submit answers", enabled: complete },
    { label: "Cancel", enabled: true },
  ];
  actions.forEach((action, index) => {
    const focused = model.state.reviewCursor === index;
    appendWrapped(
      lines,
      focused ? model.theme.fg("accent", "> ") : "  ",
      model.theme.fg(!action.enabled ? "dim" : focused ? "accent" : "text", action.label),
      width,
    );
  });
  return lines;
}

export function renderQuestionnaireView(model: QuestionnaireRenderModel, width: number): string[] {
  const renderWidth = Math.max(1, width);
  const lines = [borderLine(renderWidth, model.theme), ...renderTabs(model, renderWidth), ""];
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
    if (model.externalEditorBusy)
      appendWrapped(lines, " ", model.theme.fg("warning", "External editor is open…"), renderWidth);
    if (model.inputError)
      appendWrapped(lines, " ", model.theme.fg("warning", model.inputError), renderWidth);
    appendWrapped(
      lines,
      " ",
      model.theme.fg(
        "dim",
        "Enter submit • Shift+Enter newline • Esc back • configured external-editor key opens editor",
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
  if (!model.input)
    appendWrapped(
      lines,
      " ",
      model.theme.fg(
        "dim",
        "Tab/←→ questions • ↑↓ move • Enter choose • Space toggle • n note • b hide • Esc cancel",
      ),
      renderWidth,
    );
  lines.push(borderLine(renderWidth, model.theme));
  return lines.map((line) => truncateToWidth(line, renderWidth, ""));
}
