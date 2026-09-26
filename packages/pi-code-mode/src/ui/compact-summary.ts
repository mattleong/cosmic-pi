/** Pure Code Mode projection for the shared compact shell. */
import * as Schema from "effect/Schema";
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { decodeOption, type CodeModeCallEntry } from "../tools/format.ts";
import { decodeCodeModeRenderDetails, type CodeModeRenderDetails } from "./tool-render-details.ts";
import { describeCodeModeIntent } from "./tool-renderer.ts";
import { codeModeCallRows } from "./call-rows.ts";
import { programIssues, programOutcome } from "./program-issues.ts";
import { resultReadCompactSummary } from "./result-read-summary.ts";

const ArgsSchema = Schema.Struct({
  intent: Schema.optional(Schema.Unknown),
  action: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});
const TextContentSchema = Schema.Array(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

type SummaryProvider = CompactSummaryProvider<unknown, unknown, unknown>;

const callCounter = (details: CodeModeRenderDetails, settled: boolean): string[] => {
  const { total, succeeded, failed, cancelled } = details.counts;
  if (total === 0) return [];
  const calls = `${total} ${total === 1 ? "call" : "calls"}`;
  const done = succeeded + failed + cancelled;
  if (!settled) return [`${done}/${calls}`, `${done}/${total}`];
  // The failure count is the fallback that survives narrow rows.
  const problems = [failed ? `${failed} failed` : "", cancelled ? `${cancelled} cancelled` : ""]
    .filter(Boolean)
    .join(" · ");
  return problems ? [`${calls} · ${problems}`, problems] : [calls];
};

/**
 * Settled executions require the current v3 ledger and consistent lifecycle details; anything
 * older or inconsistent declines, leaving the shell's generic row.
 */
export const codeModeCompactSummary = (
  { phase, args, result, context }: Parameters<SummaryProvider>[0],
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): ReturnType<SummaryProvider> => {
  try {
    const input = decodeOption(ArgsSchema, args);
    if (input?.action === "result.read") {
      const heading = {
        action: input.action,
        subject: input.id ?? "",
        compactSubject: "Saved output",
        showTiming: true as const,
      };
      if (result === undefined || phase !== "settled")
        return phase === "settled" ? undefined : heading;
      return resultReadCompactSummary(result.details, input.id ?? "");
    }
    const heading = { subject: describeCodeModeIntent(input?.intent), showTiming: true as const };
    if (result === undefined) return phase === "settled" ? undefined : heading;
    const details = decodeCodeModeRenderDetails(result.details);
    if (!details.compactEligible || details.compactAttention === undefined) return undefined;
    const settled = phase === "settled";
    const children = {
      total: details.counts.total,
      entries: codeModeCallRows(details, phase, liveElapsed),
    };
    const counters = callCounter(details, settled);
    if (!settled) return { ...heading, counters, children };
    const isError = context.isError === true;
    // outputKind is emitted only by the owned successful execution path, unlike isError=false.
    if (!isError && !details.cancelled && details.outputKind === undefined) return undefined;
    const text = (decodeOption(TextContentSchema, result.content) ?? [])
      .map((part) => part.text)
      .join("\n");
    const issues = programIssues(details, children.entries, text, isError);
    const summary: CompactSummary = {
      ...heading,
      counters,
      children,
      issues,
      outcome: programOutcome(details, children.entries, issues, isError),
    };
    return summary;
  } catch {
    return undefined;
  }
};
