/** Pure Code Mode projection for the opt-in shared compact shell. */
import * as Schema from "effect/Schema";
import {
  isCompactAttention,
  selectCompactChildren,
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

const ArgsSchema = Schema.Struct({ intent: Schema.optional(Schema.Unknown) });
const TextContentSchema = Schema.Array(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

type SummaryProvider = CompactSummaryProvider<unknown, unknown, unknown>;

export const codeModeCompactSummary = (
  { phase, args, result, context }: Parameters<SummaryProvider>[0],
  liveElapsed?: (call: CodeModeCallEntry) => number | undefined,
): ReturnType<SummaryProvider> => {
  try {
    const subject = describeCodeModeIntent(decodeOption(ArgsSchema, args)?.intent);
    const heading = { subject, showTiming: true as const };
    if (result === undefined) return phase === "settled" ? undefined : heading;
    const details = decodeCodeModeRenderDetails(result.details);
    if (!details.compactEligible) return undefined;
    const { total, succeeded, failed, cancelled, running, queued } = details.counts;
    const counters = [
      `${succeeded + failed + cancelled}/${total} done${failed ? ` · ${failed} failed` : ""}`,
    ];
    const children = { total, entries: codeModeCallRows(details, phase, liveElapsed) };
    // Keep informational hints parent-owned when an outer failure bypasses details.
    const notices: CompactNotice[] = codeModeEvidenceNotices(details).map((notice) => ({
      ...notice,
      expandedInResult: true,
    }));
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
    const visibleNotices = context.expanded
      ? []
      : selectCompactChildren(children).entries.flatMap(
          (child) => child.notices?.filter(isCompactAttention) ?? [],
        );
    for (let index = notices.length - 1; index >= 0; index--) {
      const notice = notices[index]!;
      if (
        isCompactAttention(notice) &&
        visibleNotices.some(
          (visible) => visible.kind === notice.kind && visible.text === notice.text,
        )
      )
        notices.splice(index, 1);
    }
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
      if (!known && rest.some((line) => line.trim().length > 0))
        notices.push({ kind: "recovery", text: rest.join("\n") });
      for (const notice of known?.notices ?? [])
        if (
          !notices.some((other) => other.kind === notice.kind && other.text === notice.text) &&
          !visibleNotices.some((other) => other.kind === notice.kind && other.text === notice.text)
        )
          notices.push(notice);
      // This only omits a redundant root explanation, never attributes the root to a
      // particular invocation. Independent child failures and their identities stay intact.
      const rootAlreadyExplained =
        !context.expanded &&
        known !== undefined &&
        selectedCalls.some(
          (child) =>
            child.label === known.tool &&
            child.failureEvidence?.code === known.evidence.code &&
            child.failureEvidence?.coverage === "complete" &&
            child.notices?.some(
              (notice) => notice.kind === "error" && notice.text === known.evidence.cause,
            ),
        );
      if (known) {
        for (let index = notices.length - 1; index >= 0; index--)
          if (notices[index]?.kind === "error" && notices[index]?.text === known.evidence.cause)
            notices.splice(index, 1);
      }
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
            cause: rootAlreadyExplained ? "" : (known?.evidence.cause ?? first),
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
