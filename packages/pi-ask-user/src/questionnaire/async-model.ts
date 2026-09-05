import type { AskUserOutcome } from "./model.ts";

export const MAX_RETAINED_REQUESTS = 16;

export interface AsyncQuestionnaireSnapshot {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly status: "pending" | "submitted" | "cancelled" | "failed";
  readonly presentation?: "queued" | "opening" | "open" | "hidden" | "settled";
  readonly independentWork: string;
  readonly blockedWork: string;
  readonly delivery: "pending" | "sending" | "sent" | "failed" | "waiter" | "none";
  readonly outcome?: AskUserOutcome;
}

export interface AsyncQuestionnaireResult {
  readonly requests: ReadonlyArray<AsyncQuestionnaireSnapshot>;
}
