import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** A rejected probe is not evidence authorizing legacy fallback. No remote data is retained. */
export class SdkNegotiationRejectedError extends Schema.TaggedError<SdkNegotiationRejectedError>()(
  "SdkNegotiationRejectedError",
  {},
) {
  override readonly message = "MCP protocol negotiation was rejected.";
}

/** The SDK wraps probe send failures once in its public negotiation error. */
export const isSdkNegotiationRejected = (error: Error): boolean =>
  error instanceof SdkNegotiationRejectedError ||
  (error instanceof SdkError &&
    error.code === SdkErrorCode.EraNegotiationFailed &&
    Predicate.isObject(error.data) &&
    "cause" in error.data &&
    error.data.cause instanceof SdkNegotiationRejectedError);
