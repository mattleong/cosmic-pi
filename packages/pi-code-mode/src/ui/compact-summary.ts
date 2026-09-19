/** Pure Code Mode projection for the opt-in shared compact shell. */
import * as Schema from "effect/Schema";
import {
  claimCompactIssue,
  isCompactAttention,
  legacyCompactIssues,
  normalizeCompactIssues,
  planCompactPresentation,
  selectCompactChildren,
  summaryCompactIssues,
  type CompactSummary,
  type CompactNotice,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { isCompactPiTool } from "../tools/mcp-evidence.ts";
import { codeModeEvidenceNotices, TRUNCATED_OUTPUT_NOTICE } from "./notices.ts";
import { decodeOption, type CodeModeCallEntry } from "../tools/format.ts";
import { decodeCodeModeRenderDetails } from "./tool-render-details.ts";
import { describeCodeModeIntent } from "./tool-renderer.ts";

import { verifiedFailurePresentation } from "./failure-presentation.ts";
import { codeModeCallRows } from "./call-rows.ts";
import { resultReadCompactSummary } from "./result-read-summary.ts";
import { codeModeOutputText } from "./result-output.ts";

const ArgsSchema = Schema.Struct({
  intent: Schema.optional(Schema.Unknown),
  action: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});
const TextContentSchema = Schema.Array(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

type SummaryProvider = CompactSummaryProvider<unknown, unknown, unknown>;

const projectCodeModeCompactSummary = (
  { phase, args, result, context }: Parameters<SummaryProvider>[0],
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): ReturnType<SummaryProvider> => {
  try {
    const input = decodeOption(ArgsSchema, args);
    const heading =
      input?.action === "result.read"
        ? { action: input.action, subject: input.id ?? "", showTiming: true as const }
        : { subject: describeCodeModeIntent(input?.intent), showTiming: true as const };
    if (result === undefined) return phase === "settled" ? undefined : heading;
    if (input?.action === "result.read")
      return phase === "settled"
        ? resultReadCompactSummary(result.details, input.id ?? "")
        : heading;
    const details = decodeCodeModeRenderDetails(result.details);
    if (!details.compactEligible) return undefined;
    const { total, succeeded, failed, cancelled, running, queued } = details.counts;
    const counters = [
      `${succeeded + failed + cancelled}/${total} done${failed ? ` · ${failed} failed` : ""}`,
    ];
    const children = { total, entries: codeModeCallRows(details, phase, liveElapsed) };
    // Keep informational hints parent-owned when an outer failure bypasses details.
    const notices: CompactNotice[] =
      details.compactAttention?.version === 2
        ? codeModeEvidenceNotices({
            ...details,
            compactAttention: {
              ...details.compactAttention,
              notices: [],
              issues: { coverage: "complete", entries: [] },
            },
            toolCalls: details.toolCalls.map((call) => ({
              ...call,
              ...(call.compact && {
                compact: {
                  ...call.compact,
                  ...(call.compact.version === 2 && {
                    issues: { coverage: "complete" as const, entries: [] },
                  }),
                  notices: context.isError
                    ? call.compact.notices.filter((notice) => !isCompactAttention(notice))
                    : [],
                },
              }),
            })),
          })
        : codeModeEvidenceNotices(details);
    const selectedCalls = context.expanded
      ? children.entries
      : selectCompactChildren(children).entries;
    // Selection preserves row identity, but semantic display status can differ from
    // lifecycle status: an errored MCP call may be uncertain, or a completed one an error.
    const visibleFailed = selectedCalls.filter(
      (child) => details.toolCalls[children.entries.indexOf(child)]?.status === "error",
    ).length;
    const hiddenFailed = Math.max(0, failed - visibleFailed);
    if (hiddenFailed > 0)
      notices.push({
        kind: "warning",
        text: `${hiddenFailed} additional nested operations failed.`,
      });
    if (cancelled > 0 && !details.cancelled)
      notices.push({
        kind: "warning",
        text: `${cancelled} nested operations cancelled; prior side effects are not rolled back.`,
      });
    if (details.truncated)
      notices.push({
        kind: "recovery",
        text: TRUNCATED_OUTPUT_NOTICE,
      });
    const evidence = details.mcpEvidence;
    if (
      details.compactAttention === undefined &&
      phase === "settled" &&
      evidence !== undefined &&
      evidence.observed !== evidence.mcp
    )
      return undefined;
    const hasAttention = notices.some(isCompactAttention);
    if (phase !== "settled") return { ...heading, counters, children, notices };
    if (running + queued > 0) {
      notices.push({
        kind: "warning",
        text: "Nested operations have no confirmed settlement. Check their state before retrying.",
      });
      return { ...heading, counters, children, notices, outcome: "uncertain" };
    }
    if (context.isError || details.cancelled) {
      const textParts = decodeOption(TextContentSchema, result.content);
      if (textParts === undefined) return undefined;
      const text = textParts.map((part) => part.text).join("\n");
      const known = verifiedFailurePresentation(text, details.failurePresentation);
      const [first = "", ...rest] = text.split("\n");
      // Unclassified history may contain recovery instructions. Only verified producer
      // coverage lets ordinary source/stack output move exclusively to expanded details.
      const hasContinuation = !known && rest.some((line) => line.trim().length > 0);
      if (hasContinuation)
        notices.push({
          code: "failure-continuation",
          kind: "recovery",
          text: rest.join("\n"),
        });
      notices.push(...(known?.notices ?? []));
      // Root provenance has no invocation identity, so it cannot suppress child evidence.
      if (details.cancelled)
        notices.push({
          kind: "warning",
          text: "Execution cancelled; prior side effects are not rolled back.",
        });
      return {
        ...heading,
        counters,
        children,
        notices,
        outcome: details.cancelled ? "cancelled" : "error",
        ...(text.length > 0 && {
          failure: {
            cause: known?.evidence.cause ?? first,
            details: text,
          },
        }),
      };
    }
    // Legacy details have no adapter evidence or hidden-call coverage. New evidence must
    // validate completely before reaching this branch; never infer outcomes from guest output.
    if (
      evidence === undefined &&
      details.compactAttention === undefined &&
      (total !== details.toolCalls.length ||
        details.toolCalls.some((call) => !isCompactPiTool(call.tool)))
    )
      return undefined;
    // outputKind is emitted only by the owned successful execution path, unlike isError=false.
    if (details.outputKind === undefined) return undefined;
    return {
      ...heading,
      counters: [
        `${total} ${total === 1 ? "tool" : "tools"}${failed ? ` · ${failed} failed` : ""}`,
      ],
      children,
      notices,
      detailsOnExpand: true,
      outcome:
        details.compactAttention?.incomplete ||
        details.compactAttention?.uncertain ||
        evidence?.unknown
          ? "uncertain"
          : details.compactAttention?.errors || evidence?.errors || evidence?.notSent
            ? "error"
            : failed + cancelled > 0 ||
                details.compactAttention?.cancelled ||
                details.compactAttention?.warnings ||
                details.truncated ||
                hasAttention
              ? "warning"
              : "success",
    };
  } catch {
    return undefined;
  }
};

/** Only producer-identified text copied into this exact body can suppress attention. */
const withBodyClaims = (input: CompactSummary): CompactSummary => {
  const summary =
    planCompactPresentation({
      summary: input,
      phase: "settled",
      isError: input.outcome === "error",
      expanded: true,
    }).summary ?? input;
  const failure = summary.failure;
  if (!failure || codeModeOutputText(failure.details) !== failure.details) return summary;
  const claims = summaryCompactIssues(summary, true).entries.flatMap((issue) => {
    const copiedRoot =
      ((issue.operation === "code-mode" && issue.code === "program-failure") ||
        (issue.operation === "outer" && issue.code === "pi-error")) &&
      issue.cause === failure.cause &&
      failure.details.split("\n")[0] === issue.cause;
    const copiedContinuation =
      (issue.operation === "code-mode" || issue.operation === "outer") &&
      issue.code === "failure-continuation" &&
      issue.cause === failure.details.split("\n").slice(1).join("\n");
    return copiedRoot || copiedContinuation ? [claimCompactIssue(issue, { cause: true })] : [];
  });
  return {
    ...summary,
    failure: { ...failure, ownedIssues: claims },
    expandedResultOwnsIssues: claims,
  };
};

/** The outer shell owns one issue block. V1 history keeps conservative legacy evidence. */
export const codeModeCompactSummary: typeof projectCodeModeCompactSummary = (
  input,
  liveElapsed,
) => {
  try {
    const summary = projectCodeModeCompactSummary(input, liveElapsed);
    if (!summary || !input.result) return summary;
    const details = decodeCodeModeRenderDetails(input.result.details);
    const attention = details.compactAttention;
    if (attention?.version !== 2) return withBodyClaims(summary);
    const own = legacyCompactIssues(summary.notices?.filter(isCompactAttention), "code-mode");
    const root =
      summary.outcome !== "cancelled" && summary.failure?.cause
        ? [
            {
              operation: "code-mode",
              code: "program-failure",
              severity: "error" as const,
              cause: summary.failure.cause,
              recovery: [],
            },
          ]
        : [];
    return withBodyClaims({
      ...summary,
      issues: normalizeCompactIssues([
        attention.issues,
        {
          coverage: attention.incomplete ? "unknown" : attention.issues.coverage,
          entries: [...own.entries, ...root],
        },
      ]),
    });
  } catch {
    return undefined;
  }
};
