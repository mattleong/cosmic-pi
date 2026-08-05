import type { AskUserQuestion, AskUserRequest } from "../tools/schema.ts";

export interface ChoiceAnswer {
  readonly key: string;
  readonly kind: "choices";
  readonly values: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  readonly note?: string;
}

export interface CustomAnswer {
  readonly key: string;
  readonly kind: "custom";
  readonly text: string;
  readonly note?: string;
}

export type AskUserAnswer = ChoiceAnswer | CustomAnswer;

export type AskUserOutcome =
  | { readonly outcome: "submitted"; readonly answers: ReadonlyArray<AskUserAnswer> }
  | { readonly outcome: "cancelled"; readonly answers: readonly [] };

export interface ChoiceDraft {
  readonly kind: "choices";
  readonly values: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
}

export interface CustomDraft {
  readonly kind: "custom";
  readonly text: string;
}

export type AnswerDraft = ChoiceDraft | CustomDraft;

export interface QuestionDraft {
  readonly cursor: number;
  readonly answer?: AnswerDraft;
  readonly note?: string;
}

export interface QuestionnaireState {
  readonly request: AskUserRequest;
  readonly currentTab: number;
  readonly reviewCursor: 0 | 1;
  readonly drafts: ReadonlyArray<QuestionDraft>;
}

export type QuestionnaireAction =
  | { readonly type: "set-tab"; readonly tab: number }
  | { readonly type: "move-tab"; readonly delta: -1 | 1 }
  | { readonly type: "set-cursor"; readonly question: number; readonly cursor: number }
  | { readonly type: "select-one"; readonly question: number; readonly choice: number }
  | { readonly type: "toggle-many"; readonly question: number; readonly choice: number }
  | { readonly type: "set-custom"; readonly question: number; readonly text: string }
  | { readonly type: "set-note"; readonly question: number; readonly note: string }
  | { readonly type: "set-review-cursor"; readonly cursor: 0 | 1 };

export const questionAt = (state: QuestionnaireState, index: number): AskUserQuestion =>
  state.request.questions[index]!;
