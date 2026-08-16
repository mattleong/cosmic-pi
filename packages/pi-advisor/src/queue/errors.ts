import { hasObjectRuntimeType } from "pi-cosmic-core";
import * as Schema from "effect/Schema";

const QueueErrorFields = { message: Schema.String } as const;
const isQueueErrorTag = <Tag>(tag: Tag): boolean => {
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

export class AdvisorQueueError extends Schema.TaggedError<AdvisorQueueError>()(
  "AdvisorQueueError",
  QueueErrorFields,
) {}

export class AdvisorQueueDisposedError extends Schema.TaggedError<AdvisorQueueDisposedError>()(
  "Disposed",
  QueueErrorFields,
) {}
export class AdvisorQueueBacklogExceededError extends Schema.TaggedError<AdvisorQueueBacklogExceededError>()(
  "BacklogExceeded",
  QueueErrorFields,
) {}
export class AdvisorQueueResetRequiredError extends Schema.TaggedError<AdvisorQueueResetRequiredError>()(
  "ResetRequired",
  QueueErrorFields,
) {}
export class AdvisorQueueBatchDroppedError extends Schema.TaggedError<AdvisorQueueBatchDroppedError>()(
  "BatchDropped",
  QueueErrorFields,
) {}
export class AdvisorQueueCorrelationMismatchError extends Schema.TaggedError<AdvisorQueueCorrelationMismatchError>()(
  "CorrelationMismatch",
  QueueErrorFields,
) {}
export class AdvisorQueueCancelledError extends Schema.TaggedError<AdvisorQueueCancelledError>()(
  "Cancelled",
  QueueErrorFields,
) {}
export class AdvisorQueueStaleEpochError extends Schema.TaggedError<AdvisorQueueStaleEpochError>()(
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

export const isAdvisorReviewQueueError = <ErrorInput>(
  error: ErrorInput,
): error is ErrorInput & AdvisorReviewQueueError => {
  return (
    hasObjectRuntimeType(error) && error !== null && "_tag" in error && isQueueErrorTag(error._tag)
  );
};
