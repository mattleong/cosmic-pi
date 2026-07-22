import * as Schema from "effect/Schema";

const QueueErrorFields = { message: Schema.String } as const;
const isQueueErrorTag = (tag: unknown): boolean => {
  switch (tag) {
    case "AdvisorQueueError":
    case "Disposed":
    case "BacklogExceeded":
    case "ResetRequired":
    case "BatchDropped":
    case "CorrelationMismatch":
    case "Cancelled":
    case "StaleEpoch":
      return true;
    default:
      return false;
  }
};

/** Compatibility fallback for unexpected runtime failures. */
export class AdvisorQueueError extends Schema.TaggedErrorClass<AdvisorQueueError>()(
  "AdvisorQueueError",
  QueueErrorFields,
) {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" && value !== null && "_tag" in value && isQueueErrorTag(value._tag)
    );
  }
}

export class AdvisorQueueDisposedError extends Schema.TaggedErrorClass<AdvisorQueueDisposedError>()(
  "Disposed",
  QueueErrorFields,
) {}
export class AdvisorQueueBacklogExceededError extends Schema.TaggedErrorClass<AdvisorQueueBacklogExceededError>()(
  "BacklogExceeded",
  QueueErrorFields,
) {}
export class AdvisorQueueResetRequiredError extends Schema.TaggedErrorClass<AdvisorQueueResetRequiredError>()(
  "ResetRequired",
  QueueErrorFields,
) {}
export class AdvisorQueueBatchDroppedError extends Schema.TaggedErrorClass<AdvisorQueueBatchDroppedError>()(
  "BatchDropped",
  QueueErrorFields,
) {}
export class AdvisorQueueCorrelationMismatchError extends Schema.TaggedErrorClass<AdvisorQueueCorrelationMismatchError>()(
  "CorrelationMismatch",
  QueueErrorFields,
) {}
export class AdvisorQueueCancelledError extends Schema.TaggedErrorClass<AdvisorQueueCancelledError>()(
  "Cancelled",
  QueueErrorFields,
) {}
export class AdvisorQueueStaleEpochError extends Schema.TaggedErrorClass<AdvisorQueueStaleEpochError>()(
  "StaleEpoch",
  QueueErrorFields,
) {}

export type AdvisorReviewQueueError =
  | AdvisorQueueError
  | AdvisorQueueDisposedError
  | AdvisorQueueBacklogExceededError
  | AdvisorQueueResetRequiredError
  | AdvisorQueueBatchDroppedError
  | AdvisorQueueCorrelationMismatchError
  | AdvisorQueueCancelledError
  | AdvisorQueueStaleEpochError;

export const isAdvisorReviewQueueError = (error: unknown): error is AdvisorReviewQueueError => {
  return (
    typeof error === "object" && error !== null && "_tag" in error && isQueueErrorTag(error._tag)
  );
};
