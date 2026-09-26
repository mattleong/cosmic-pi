import type { AskUserOutcome } from "./protocol.ts";
import type { AskUserRequest } from "./schema.ts";

export type { AskUserOutcome } from "./protocol.ts";

type DraftAnswerContent =
  | { readonly kind: "choices"; readonly values: ReadonlyArray<string> }
  | { readonly kind: "custom"; readonly text: string }
  | { readonly kind: "text"; readonly text: string };

/** Internal answer content retained until a question supplies its public key and choice labels. */
export type AskUserAnswerDraft = DraftAnswerContent & {
  readonly note?: string;
};

export type AskUserAnswer = Extract<AskUserOutcome, { outcome: "submitted" }>["answers"][number];

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
  | { readonly type: "set-text"; readonly question: number; readonly text: string }
  | { readonly type: "set-note"; readonly question: number; readonly note: string }
  | { readonly type: "set-review-cursor"; readonly cursor: 0 | 1 };
