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
import { isCompactPiTool } from "../tools/compact-subject.ts";
import { codeModeOutputNotice } from "./notices.ts";
import { compactParentNotices, compactSettledOutcome } from "./compact-summary-context.ts";
import { decodeOption, type CodeModeCallEntry } from "../tools/format.ts";
import { decodeCodeModeRenderDetails, type CodeModeRenderDetails } from "./tool-render-details.ts";
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

/** Preserve unclassified recovery text unless producer evidence covers the exact failure body. */
const projectFailureSummary = (
  textParts: typeof TextContentSchema.Type | undefined,
  details: CodeModeRenderDetails,
  base: CompactSummary,
  notices: CompactNotice[],
): CompactSummary | undefined => {
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
      description: "The run was cancelled. Earlier changes may remain.",
    });
  return {
    ...base,
    notices,
    outcome: details.cancelled ? "cancelled" : "error",
    ...(text.length > 0 && {
      failure: {
        cause: known?.evidence.cause ?? first,
        description: details.cancelled
          ? "The run was cancelled."
          : "The program reported an error.",
        details: text,
      },
    }),
  };
};

const projectCodeModeCompactSummary = (
  { phase, args, result, context }: Parameters<SummaryProvider>[0],
  details: CodeModeRenderDetails | undefined,
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): ReturnType<SummaryProvider> => {
  try {
    const input = decodeOption(ArgsSchema, args);
    const heading =
      input?.action === "result.read"
        ? {
            action: input.action,
            subject: input.id ?? "",
            compactSubject: "Saved output",
            showTiming: true as const,
          }
        : { subject: describeCodeModeIntent(input?.intent), showTiming: true as const };
    if (result === undefined) return phase === "settled" ? undefined : heading;
    if (input?.action === "result.read")
      return phase === "settled"
        ? resultReadCompactSummary(result.details, input.id ?? "")
        : heading;
    if (!details?.compactEligible) return undefined;
    const { total, succeeded, failed, cancelled, running, queued } = details.counts;
    const counters = [
      `${succeeded + failed + cancelled}/${total} done${failed ? ` · ${failed} failed` : ""}`,
    ];
    const children = { total, entries: codeModeCallRows(details, phase, liveElapsed) };
    const notices = compactParentNotices(details);
    const selectedCalls = context.expanded
      ? children.entries
      : selectCompactChildren(children).entries;
    // Selection preserves row identity, but semantic display status can differ from
    // lifecycle status: an errored MCP call may be uncertain, or a completed one an error.
    const visibleFailed = selectedCalls.filter(
      (child) => details.toolCalls[children.entries.indexOf(child)]?.status === "error",
    ).length;
    // Hidden v2 children still contribute their exact issues to the shared attention block.
    // Only failures with no represented error need a generic fallback count.
    const visibleRows = new Set(selectedCalls);
    const representedHiddenFailed = details.toolCalls.filter(
      (call, index) =>
        call.status === "error" &&
        !visibleRows.has(children.entries[index]!) &&
        call.compact?.issues.entries.some((issue) => issue.severity === "error") === true,
    ).length;
    const hiddenFailed = Math.max(0, failed - visibleFailed - representedHiddenFailed);
    if (hiddenFailed > 0)
      notices.push({
        kind: "warning",
        text: `${hiddenFailed} additional nested operations failed.`,
        description: `${hiddenFailed} other operations failed.`,
      });
    if (cancelled > 0 && !details.cancelled)
      notices.push({
        kind: "warning",
        text: `${cancelled} nested operations cancelled; prior side effects are not rolled back.`,
        description: `${cancelled} operations were cancelled. Earlier changes may remain.`,
      });
    const outputNotice = codeModeOutputNotice(details);
    if (outputNotice !== undefined)
      notices.push({
        ...outputNotice,
        ...(isCompactAttention(outputNotice) && {
          description: details.receiptsReadOnly
            ? "Only part of the output was returned."
            : "Only part of the output was returned. Earlier changes may remain.",
        }),
      });
    const hasAttention = notices.some(isCompactAttention);
    if (phase !== "settled") return { ...heading, counters, children, notices };
    if (running + queued > 0) {
      notices.push({
        kind: "warning",
        text: "Nested operations have no confirmed settlement. Check their state before retrying.",
        description: "Some operations may still be running.",
      });
      return { ...heading, counters, children, notices, outcome: "uncertain" };
    }
    if (context.isError || details.cancelled) {
      return projectFailureSummary(
        decodeOption(TextContentSchema, result.content),
        details,
        { ...heading, counters, children },
        notices,
      );
    }

    // Pre-ledger details have no adapter evidence or hidden-call coverage. New evidence must
    // validate completely before reaching this branch; never infer outcomes from guest output.
    if (
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
      outcome: compactSettledOutcome(details, hasAttention),
    };
  } catch {
    return undefined;
  }
};

/** Only producer-identified text copied into this exact body can suppress attention. */
const bodyClaims = (summary: CompactSummary) => {
  const failure = summary.failure;
  if (!failure || codeModeOutputText(failure.details) !== failure.details) return [];
  return summaryCompactIssues(summary, true).entries.flatMap((issue) => {
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
};

const withBodyClaims = (input: CompactSummary): CompactSummary => {
  const prepared = input.failure
    ? {
        ...input,
        failure: {
          ...input.failure,
          ownedIssues: [...(input.failure.ownedIssues ?? []), ...bodyClaims(input)],
        },
      }
    : input;
  const summary =
    planCompactPresentation({
      summary: prepared,
      phase: "settled",
      isError: prepared.outcome === "error",
      expanded: true,
    }).summary ?? prepared;
  if (!summary.failure) return summary;
  const claims = bodyClaims(summary);
  return {
    ...summary,
    failure: { ...summary.failure, ownedIssues: claims },
    expandedResultOwnsIssues: claims,
  };
};

/** The outer shell owns one issue block. Pre-ledger history keeps conservative legacy evidence. */
export const codeModeCompactSummary = (
  input: Parameters<SummaryProvider>[0],
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): ReturnType<SummaryProvider> => {
  try {
    const details =
      input.result === undefined ? undefined : decodeCodeModeRenderDetails(input.result.details);
    const summary = projectCodeModeCompactSummary(input, details, liveElapsed);
    if (!summary || !input.result) return summary;
    const attention = details?.compactAttention;
    if (attention === undefined) return withBodyClaims(summary);
    const own = legacyCompactIssues(summary.notices?.filter(isCompactAttention), "code-mode");
    const root =
      summary.outcome !== "cancelled" && summary.failure?.cause
        ? [
            {
              operation: "code-mode",
              code: "program-failure",
              severity: "error" as const,
              cause: summary.failure.cause,
              description: summary.failure.description,
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
