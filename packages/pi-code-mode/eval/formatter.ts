import * as Predicate from "effect/Predicate";
import type { CodeModeSuccess } from "../src/boundary/codemode-runtime.ts";
import { formatCodeModeSuccess } from "../src/tools/format.ts";
import { clampModelVisibleText } from "../src/tools/limits.ts";

export interface FormatterMeasurements {
  calls: number;
  structuredCalls: number;
  stringCalls: number;
  changedCalls: number;
  prettyBytes: number;
  compactBytes: number;
  prettyFallbackCalls: number;
  clampedCalls: number;
}
export const freshFormatterMeasurements = (): FormatterMeasurements => ({
  calls: 0,
  structuredCalls: 0,
  stringCalls: 0,
  changedCalls: 0,
  prettyBytes: 0,
  compactBytes: 0,
  prettyFallbackCalls: 0,
  clampedCalls: 0,
});

/** Exact pre-e0e5f90 policy: value-only pretty budget, then unchanged logs, then caller clamp. */
const historical = (result: CodeModeSuccess, maxOutputBytes: number) => {
  const pretty = Predicate.isString(result.value)
    ? result.value
    : (JSON.stringify(result.value, null, 2) ?? String(result.value));
  const fallback = !Predicate.isString(result.value) && Buffer.byteLength(pretty) > maxOutputBytes;
  const output = fallback ? (JSON.stringify(result.value) ?? String(result.value)) : pretty;
  const text =
    result.logs && result.logs.length > 0
      ? `${output}${output.length > 0 ? "\n\n" : ""}Logs:\n${result.logs.join("\n")}`
      : output;
  return { text, fallback };
};
export const formatHistoricalSuccess = (result: CodeModeSuccess, maxOutputBytes: number): string =>
  historical(result, maxOutputBytes).text;

/** Observe both renderings of the same value, without retaining that value, strings, or logs. */
export const measuredFormatter =
  (variant: "baseline" | "candidate", metrics: FormatterMeasurements) =>
  (result: CodeModeSuccess, maxOutputBytes: number): string => {
    const pretty = historical(result, maxOutputBytes);
    const compact = formatCodeModeSuccess(result);
    const prettyClamped = clampModelVisibleText(pretty.text, maxOutputBytes);
    const compactClamped = clampModelVisibleText(compact, maxOutputBytes);
    metrics.calls++;
    if (Predicate.isString(result.value)) metrics.stringCalls++;
    else metrics.structuredCalls++;
    if (prettyClamped !== compactClamped) metrics.changedCalls++;
    metrics.prettyBytes += Buffer.byteLength(prettyClamped);
    metrics.compactBytes += Buffer.byteLength(compactClamped);
    if (pretty.fallback) metrics.prettyFallbackCalls++;
    if (prettyClamped !== pretty.text || compactClamped !== compact) metrics.clampedCalls++;
    // Return the unbounded rendering. Production execution still applies the real final clamp.
    return variant === "baseline" ? pretty.text : compact;
  };
