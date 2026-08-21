import type {
  AskUserAnswer,
  AskUserOutcome,
  QuestionnaireAction,
  QuestionnaireState,
  QuestionDraft,
} from "./model.ts";
import type { AskUserRequest } from "../tools/schema.ts";

export const createQuestionnaireState = (request: AskUserRequest): QuestionnaireState => ({
  request,
  currentTab: 0,
  reviewCursor: 0,
  drafts: request.questions.map(() => ({ cursor: 0 })),
});

const updateDraft = (
  state: QuestionnaireState,
  question: number,
  update: (draft: QuestionDraft) => QuestionDraft,
): QuestionnaireState => ({
  ...state,
  drafts: state.drafts.map((draft, index) => (index === question ? update(draft) : draft)),
});

export function reduceQuestionnaire(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireState {
  switch (action.type) {
    case "set-tab":
      return {
        ...state,
        currentTab: Math.max(0, Math.min(state.request.questions.length, action.tab)),
      };
    case "move-tab": {
      const count = state.request.questions.length + 1;
      return { ...state, currentTab: (state.currentTab + action.delta + count) % count };
    }
    case "set-cursor":
      return updateDraft(state, action.question, (draft) => ({ ...draft, cursor: action.cursor }));
    case "select-one": {
      const choice = state.request.questions[action.question]?.choices[action.choice];
      if (!choice) return state;
      return updateDraft(state, action.question, (draft) => ({
        ...draft,
        answer: { kind: "choices", values: [choice.value], labels: [choice.label] },
      }));
    }
    case "toggle-many": {
      const choice = state.request.questions[action.question]?.choices[action.choice];
      if (!choice) return state;
      return updateDraft(state, action.question, (draft) => {
        const current =
          draft.answer?.kind === "choices"
            ? draft.answer
            : { kind: "choices" as const, values: [], labels: [] };
        const selected = current.values.includes(choice.value);
        const selectedValues = selected
          ? current.values.filter((value) => value !== choice.value)
          : [...current.values, choice.value];
        const selectedChoices = state.request.questions[action.question]!.choices.filter(
          (candidate) => selectedValues.includes(candidate.value),
        );
        const values = selectedChoices.map((candidate) => candidate.value);
        const labels = selectedChoices.map((candidate) => candidate.label);
        if (values.length > 0) return { ...draft, answer: { kind: "choices", values, labels } };
        return draft.note ? { cursor: draft.cursor, note: draft.note } : { cursor: draft.cursor };
      });
    }
    case "set-custom":
      return updateDraft(state, action.question, (draft) => ({
        ...draft,
        answer: { kind: "custom", text: action.text },
      }));
    case "set-note":
      return updateDraft(state, action.question, (draft) => {
        const note = action.note.trim();
        if (note) return { ...draft, note };
        return draft.answer
          ? { cursor: draft.cursor, answer: draft.answer }
          : { cursor: draft.cursor };
      });
    case "set-review-cursor":
      return { ...state, reviewCursor: action.cursor };
  }
}

export const isQuestionnaireComplete = (state: QuestionnaireState): boolean =>
  state.drafts.every((draft) => draft.answer !== undefined);

export function submitQuestionnaire(state: QuestionnaireState): AskUserOutcome | undefined {
  if (!isQuestionnaireComplete(state)) return undefined;
  const answers: AskUserAnswer[] = [];
  state.drafts.forEach((draft, index) => {
    const answer = draft.answer;
    const question = state.request.questions[index];
    if (!answer || !question) return;
    if (answer.kind === "custom") {
      const submitted: AskUserAnswer = { key: question.key, kind: "custom", text: answer.text };
      answers.push(draft.note ? { ...submitted, note: draft.note } : submitted);
      return;
    }
    const submitted: AskUserAnswer = {
      key: question.key,
      kind: "choices",
      values: answer.values,
      labels: answer.labels,
    };
    answers.push(draft.note ? { ...submitted, note: draft.note } : submitted);
  });
  return { outcome: "submitted", answers };
}

export const cancelQuestionnaire = (): AskUserOutcome => ({ outcome: "cancelled", answers: [] });
