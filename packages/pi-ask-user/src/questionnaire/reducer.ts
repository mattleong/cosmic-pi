import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type {
  AskUserAnswer,
  AskUserAnswerDraft,
  AskUserOutcome,
  QuestionnaireAction,
  QuestionnaireState,
  QuestionDraft,
} from "./model.ts";
import type { AskUserQuestion, AskUserRequest } from "./schema.ts";
import { validateQuestionnaireInput } from "./validation.ts";

export const createQuestionnaireState = (request: AskUserRequest): QuestionnaireState => ({
  request,
  currentTab: 0,
  reviewCursor: 0,
  drafts: Arr.map(request.questions, () => ({ cursor: 0 })),
});

const updateDraft = (
  state: QuestionnaireState,
  question: number,
  update: (draft: QuestionDraft) => QuestionDraft,
): QuestionnaireState => ({
  ...state,
  drafts: Arr.map(state.drafts, (draft, index) => (index === question ? update(draft) : draft)),
});

type ActionOf<Type extends QuestionnaireAction["type"]> = Extract<
  QuestionnaireAction,
  { readonly type: Type }
>;

const selectOne = (state: QuestionnaireState, action: ActionOf<"select-one">) => {
  const question = state.request.questions[action.question];
  if (question?.mode !== "single") return state;
  const choice = question.choices[action.choice];
  if (!choice) return state;
  return updateDraft(state, action.question, (draft) => ({
    ...draft,
    answer: { kind: "choices", values: [choice.value] },
  }));
};

const toggleMany = (state: QuestionnaireState, action: ActionOf<"toggle-many">) => {
  const question = state.request.questions[action.question];
  if (question?.mode !== "multiple") return state;
  const choice = question.choices[action.choice];
  if (!choice) return state;
  return updateDraft(state, action.question, (draft) => {
    const selected = new Set(draft.answer?.kind === "choices" ? draft.answer.values : []);
    if (selected.has(choice.value)) selected.delete(choice.value);
    else selected.add(choice.value);
    const values = Arr.map(
      Arr.filter(question.choices, (candidate) => selected.has(candidate.value)),
      (candidate) => candidate.value,
    );
    if (values.length > 0) return { ...draft, answer: { kind: "choices", values } };
    return draft.note ? { cursor: draft.cursor, note: draft.note } : { cursor: draft.cursor };
  });
};

const setAnswerText = (state: QuestionnaireState, action: ActionOf<"set-custom" | "set-text">) => {
  const question = state.request.questions[action.question];
  const kind = action.type === "set-text" ? "text" : "custom";
  if (!question || (question.mode === "text") !== (kind === "text")) return state;
  const checked = validateQuestionnaireInput(action.text, kind);
  if (checked.error !== undefined) return state;
  return updateDraft(state, action.question, (draft) => ({
    ...draft,
    answer: { kind, text: checked.value },
  }));
};

const setNote = (state: QuestionnaireState, action: ActionOf<"set-note">) =>
  updateDraft(state, action.question, (draft) => {
    const note = Str.trim(action.note);
    if (note) return { ...draft, note };
    return draft.answer ? { cursor: draft.cursor, answer: draft.answer } : { cursor: draft.cursor };
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
    case "select-one":
      return selectOne(state, action);
    case "toggle-many":
      return toggleMany(state, action);
    case "set-custom":
    case "set-text":
      return setAnswerText(state, action);
    case "set-note":
      return setNote(state, action);
    case "set-review-cursor":
      return { ...state, reviewCursor: action.cursor };
  }
  return state;
}

export const isQuestionnaireComplete = (state: QuestionnaireState): boolean =>
  Arr.every(state.drafts, (draft) => draft.answer !== undefined);

export function finalizeAskUserAnswer(
  question: AskUserQuestion,
  draft: AskUserAnswerDraft,
): AskUserAnswer {
  if (draft.kind !== "choices") return { key: question.key, ...draft };
  if (question.mode === "text") throw new Error("Text questions cannot have choice answers.");

  const choicesByValue = new Map(
    Arr.map(question.choices, (choice) => [choice.value, choice] as const),
  );
  const selected = Arr.getSomes(
    Arr.map(Arr.dedupe(draft.values), (value) => Option.fromNullishOr(choicesByValue.get(value))),
  );
  const answer: AskUserAnswer = {
    key: question.key,
    kind: "choices",
    values: Arr.map(selected, (choice) => choice.value),
    labels: Arr.map(selected, (choice) => choice.label),
  };
  return draft.note ? { ...answer, note: draft.note } : answer;
}

export function submitQuestionnaire(state: QuestionnaireState): AskUserOutcome | undefined {
  if (!isQuestionnaireComplete(state)) return undefined;
  const answers = Arr.filterMap(state.drafts, (draft, index) => {
    const answer = draft.answer;
    const question = state.request.questions[index];
    if (!answer || !question) return Result.failVoid;
    return Result.succeed(
      finalizeAskUserAnswer(question, draft.note ? { ...answer, note: draft.note } : answer),
    );
  });
  return { outcome: "submitted", answers };
}

export const cancelQuestionnaire = (): AskUserOutcome => ({ outcome: "cancelled", answers: [] });
