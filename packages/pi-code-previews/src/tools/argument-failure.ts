import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CompactIssue } from "./compact-issues";

// Pi rejects a call before it runs with these results: final arguments that are not a JSON object
// (pi-ai `parseToolCallArguments`), or arguments that fail the tool's schema (`validateToolArguments`).
const MALFORMED = /^Invalid arguments for tool "[^"\n]*": /u;
const MISMATCHED = /^Validation failed for tool "[^"\n]*":\n/u;
const NOT_AN_OBJECT = "Tool arguments must be a JSON object";
const RECEIVED = "\n\nReceived arguments:\n";

/**
 * Classifies Pi's argument validation failure. The detail keeps Pi's diagnostic; the echoed
 * arguments stay in the raw result text, which expansion already shows in full.
 */
export function argumentFailureIssue(text: string): CompactIssue | undefined {
  const malformed = MALFORMED.exec(text)?.[0];
  const mismatched = malformed === undefined ? MISMATCHED.exec(text)?.[0] : undefined;
  const prefix = malformed ?? mismatched;
  if (prefix === undefined) return undefined;
  const body = text.slice(prefix.length);
  const end = body.indexOf(RECEIVED);
  const detail = sanitizeDiagnosticContent(end < 0 ? body : body.slice(0, end))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  const message =
    mismatched !== undefined
      ? "The arguments didn't match the tool's schema"
      : body.startsWith(NOT_AN_OBJECT)
        ? "The arguments weren't a JSON object"
        : "The arguments weren't valid JSON";
  return { severity: "error", code: "invalid-arguments", message, ...(detail && { detail }) };
}

type CallRenderEvidence = Pick<
  Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
  "args" | "isError" | "durationMs"
>;

/**
 * Whether Pi refused to run a call whose arguments are empty, as it does after parsing malformed
 * final JSON as `{}`. A heading built from argument defaults would misdescribe such a call, so it
 * names only the tool. Pi records a duration only for calls that ran, so an executed `{}` call
 * keeps its defaults.
 */
export function isRejectedEmptyCall(context: CallRenderEvidence): boolean {
  return (
    context.isError &&
    context.durationMs === undefined &&
    Predicate.isObject(context.args) &&
    Object.keys(context.args).length === 0
  );
}
