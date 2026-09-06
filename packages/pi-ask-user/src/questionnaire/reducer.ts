import type {
  AskUserAnswer,
  AskUserAnswerDraft,
  AskUserOutcome,
  QuestionnaireAction,
  QuestionnaireState,
  QuestionDraft,
} from "./model.ts";
import type { AskUserQuestion, AskUserRequest } from "./schema.ts";

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
      const question = state.request.questions[action.question];
      const choice = question?.choices[action.choice];
      if (!choice) return state;
      return updateDraft(state, action.question, (draft) => ({
        ...draft,
        answer: { kind: "choices", values: [choice.value] },
      }));
    }
    case "toggle-many": {
      const question = state.request.questions[action.question];
      const choice = question?.choices[action.choice];
      if (!choice) return state;
      return updateDraft(state, action.question, (draft) => {
        const selected = new Set(draft.answer?.kind === "choices" ? draft.answer.values : []);
        if (selected.has(choice.value)) selected.delete(choice.value);
        else selected.add(choice.value);
        const values = question.choices
          .filter((candidate) => selected.has(candidate.value))
          .map((candidate) => candidate.value);
        if (values.length > 0) return { ...draft, answer: { kind: "choices", values } };
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

export function finalizeAskUserAnswer(
  question: AskUserQuestion,
  draft: AskUserAnswerDraft,
): AskUserAnswer {
  if (draft.kind === "custom") return { key: question.key, ...draft };

  const choicesByValue = new Map(question.choices.map((choice) => [choice.value, choice]));
  const seen = new Set<string>();
  const selected = draft.values.flatMap((value) => {
    if (seen.has(value)) return [];
    seen.add(value);
    const choice = choicesByValue.get(value);
    return choice ? [choice] : [];
  });
  const answer: AskUserAnswer = {
    key: question.key,
    kind: "choices",
    values: selected.map((choice) => choice.value),
    labels: selected.map((choice) => choice.label),
  };
  return draft.note ? { ...answer, note: draft.note } : answer;
}

export function submitQuestionnaire(state: QuestionnaireState): AskUserOutcome | undefined {
  if (!isQuestionnaireComplete(state)) return undefined;
  const answers = state.drafts.flatMap((draft, index) => {
    const answer = draft.answer;
    const question = state.request.questions[index];
    if (!answer || !question) return [];
    return [finalizeAskUserAnswer(question, draft.note ? { ...answer, note: draft.note } : answer)];
  });
  return { outcome: "submitted", answers };
}

export const cancelQuestionnaire = (): AskUserOutcome => ({ outcome: "cancelled", answers: [] });
