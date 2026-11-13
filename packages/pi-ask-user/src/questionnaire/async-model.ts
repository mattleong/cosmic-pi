import * as Schema from "effect/Schema";
import type { AskUserOutcome } from "./model.ts";

export const MAX_RETAINED_REQUESTS = 16;

export const AsyncStatusSchema = Schema.Literals(["pending", "submitted", "cancelled", "failed"]);
export const AsyncPresentationSchema = Schema.Literals([
  "queued",
  "opening",
  "open",
  "hidden",
  "settled",
]);
export const AsyncDeliverySchema = Schema.Literals([
  "pending",
  "sending",
  "sent",
  "failed",
  "waiter",
  "none",
]);
export const PendingPresentationSchema = Schema.Literals(["open", "hidden", "queued"]);

/** A question's title by its answer key, for display only. */
interface AsyncQuestionTitle {
  readonly key: string;
  readonly title: string;
}

export interface AsyncQuestionnaireSnapshot {
  readonly requestId: string;
  readonly deliveryId: string;
  readonly status: typeof AsyncStatusSchema.Type;
  readonly presentation?: typeof AsyncPresentationSchema.Type;
  readonly independentWork: string;
  readonly blockedWork: string;
  readonly delivery: typeof AsyncDeliverySchema.Type;
  readonly outcome?: AskUserOutcome;
  /** Titles that label answers in renderers; never part of model text or structured results. */
  readonly titles?: ReadonlyArray<AsyncQuestionTitle>;
}

/** Where a pending questionnaire stands for the user: on screen, hidden, or queued behind others. */
export type PendingPresentation = typeof PendingPresentationSchema.Type;

export interface AsyncQuestionnaireResult {
  readonly requests: ReadonlyArray<AsyncQuestionnaireSnapshot>;
}
