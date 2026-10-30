import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { getTextContent } from "pi-code-previews";
import * as Str from "effect/String";
import { isSubagentError, subagentErrorCode, userFailureText } from "../run/errors.ts";
import { clipText } from "pi-cosmic-core/display";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import { sanitizeDiagnosticText } from "../run/state.ts";
import {
  MAX_FAILURE_CODE_CHARS,
  MAX_TOOL_FAILURE_MESSAGE_CHARS,
  SUBAGENT_CARD_DETAILS_VERSION,
  ToolFailureDetailsSchema,
  type ToolFailureDetails,
} from "./details-schema.ts";

/**
 * The details a rejected call's error result carries: its code and its failure as the user reads
 * it, without the agent procedure its text adds. Undefined for rejections that aren't this
 * package's typed failures, whose text is all there is.
 */
export const toolFailureDetails = (cause: unknown): ToolFailureDetails | undefined => {
  if (!isSubagentError(cause)) return undefined;
  // Redacted like a diagnostic, keeping the failure's line breaks.
  const message = Str.trim(
    clipText(
      sanitizeDiagnosticContent(userFailureText(cause), {
        maximumLength: MAX_TOOL_FAILURE_MESSAGE_CHARS + 2,
      }),
      MAX_TOOL_FAILURE_MESSAGE_CHARS,
    ),
  );
  if (!message) return undefined;
  const code = Str.trim(sanitizeDiagnosticText(subagentErrorCode(cause), MAX_FAILURE_CODE_CHARS));
  return {
    version: SUBAGENT_CARD_DETAILS_VERSION,
    action: "failure",
    ...(code && { code }),
    message,
  };
};

const decodeToolFailureDetails = decodeUnknownOrUndefined(ToolFailureDetailsSchema);

/** A rejected call's failure: its code, when known, and the text the user may read. */
export interface RejectedFailure {
  readonly code?: string | undefined;
  readonly message: string;
}

export const CODED_FAILURE = /^\[([a-z][a-z0-9_]*)\] /u;

/** A failure from the text Pi kept alone, which leads with its code in brackets when it has one. */
export const textFailure = (text: string): RejectedFailure => {
  const code = CODED_FAILURE.exec(Str.trimStart(text))?.[1];
  return { ...(code !== undefined && { code }), message: Str.trim(text) };
};

/**
 * A rejected call's failure from its recorded details, or, for results saved without them, from
 * the text Pi kept.
 */
export const rejectedFailure = (result: {
  readonly content: Parameters<typeof getTextContent>[0];
  readonly details?: unknown;
}): RejectedFailure => {
  const recorded = decodeToolFailureDetails(result.details);
  return recorded ?? textFailure(getTextContent(result.content));
};

/**
 * Whether a rejected call recorded its failure. Its issues then carry the whole failure, which
 * text Pi kept alone, such as an argument rejection, doesn't promise.
 */
export const hasRecordedFailure = (result: { readonly details?: unknown }): boolean =>
  decodeToolFailureDetails(result.details) !== undefined;

/** The failure text a rejected call's result shows the user. */
export const rejectedFailureText = (result: {
  readonly content: Parameters<typeof getTextContent>[0];
  readonly details?: unknown;
}): string => decodeToolFailureDetails(result.details)?.message ?? getTextContent(result.content);
