import type { AskUserOutcome } from "./model.ts";

export const MAX_RETAINED_REQUESTS = 16;

/** A question's title by its answer key, for display only. */
export interface AsyncQuestionTitle {
  readonly key: string;
  readonly title: string;
}

export interface AsyncQuestionnaireSnapshot {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly status: "pending" | "submitted" | "cancelled" | "failed";
  readonly presentation?: "queued" | "opening" | "open" | "hidden" | "settled";
  readonly independentWork: string;
  readonly blockedWork: string;
  readonly delivery: "pending" | "sending" | "sent" | "failed" | "waiter" | "none";
  readonly outcome?: AskUserOutcome;
  /** Titles that label answers in renderers; never part of model text or structured results. */
  readonly titles?: ReadonlyArray<AsyncQuestionTitle>;
}

/** Where a pending questionnaire stands for the user: on screen, hidden, or queued behind others. */
export type PendingPresentation = "open" | "hidden" | "queued";

export interface AsyncQuestionnaireResult {
  readonly requests: ReadonlyArray<AsyncQuestionnaireSnapshot>;
}
