import * as Schema from "effect/Schema";
import { hasObjectRuntimeType } from "pi-cosmic-core";

const QueueErrorFields = { message: Schema.String } as const;
const isQueueErrorTag = <Tag>(tag: Tag): boolean => {
  switch (tag) {
    case "AdvisorQueueError":
    case "Disposed":
    case "ResetRequired":
    case "BatchDropped":
    case "CorrelationMismatch":
    case "Cancelled":
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

export type AdvisorReviewQueueError =
  | AdvisorQueueError
  | AdvisorQueueDisposedError
  | AdvisorQueueResetRequiredError
  | AdvisorQueueBatchDroppedError
  | AdvisorQueueCorrelationMismatchError
  | AdvisorQueueCancelledError;

export const isAdvisorReviewQueueError = <ErrorInput>(
  error: ErrorInput,
): error is ErrorInput & AdvisorReviewQueueError =>
  hasObjectRuntimeType(error) && error !== null && "_tag" in error && isQueueErrorTag(error._tag);
