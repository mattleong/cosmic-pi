import type { AskUserRequest } from "./schema.ts";

type AnswerContent =
  | {
      readonly kind: "choices";
      readonly values: ReadonlyArray<string>;
      readonly labels: ReadonlyArray<string>;
    }
  | { readonly kind: "custom"; readonly text: string };

type DraftAnswerContent =
  | { readonly kind: "choices"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "custom"; readonly text: string };

/** Internal answer content retained until a question supplies its public key and choice labels. */
export type AskUserAnswerDraft = DraftAnswerContent & {
  readonly note?: string;
};

export type AskUserAnswer = AnswerContent & {
  readonly key: string;
  readonly note?: string;
};

export type AskUserOutcome =
  | { readonly outcome: "submitted"; readonly answers: ReadonlyArray<AskUserAnswer> }
  | { readonly outcome: "cancelled"; readonly answers: readonly [] };

export interface QuestionDraft {
  readonly cursor: number;
  readonly answer?: DraftAnswerContent;
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
