/** Pure Code Mode projection for the opt-in shared compact shell. */
import * as Schema from "effect/Schema";
import {
  isCompactAttention,
  selectCompactChildren,
  type CompactNotice,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { INCOMPLETE_ATTENTION } from "../tools/compact-evidence.ts";
import { isCompactPiTool, mcpAttention } from "../tools/mcp-evidence.ts";
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
    const notices: CompactNotice[] = (details.compactAttention?.notices ?? []).map((notice) => ({
      ...notice,
      expandedInResult: true,
    }));
    // The owned outer-failure shell bypasses the detailed renderer. Keep retained
    // informational hints parent-owned there, too, even for visible children.
    for (const call of details.toolCalls) {
      for (const notice of call.compact?.notices ?? []) {
        if (
          !notices.some(
            (existing) => existing.kind === notice.kind && existing.text === notice.text,
          )
        )
          notices.push({ ...notice, expandedInResult: true });
      }
    }
    if (details.compactAttention?.incomplete)
      notices.push({ kind: "warning", text: INCOMPLETE_ATTENTION, expandedInResult: true });
    const selectedCalls = context.expanded
      ? children.entries
      : selectCompactChildren(children).entries;
    const hiddenFailed = Math.max(
      0,
      failed - selectedCalls.filter((call) => call.status === "error").length,
    );
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
        text: "Output truncated by the output limit. Narrow the returned output; prior operations may already have taken effect.",
      });
    const evidence = details.mcpEvidence;
    if (
      details.compactAttention === undefined &&
      phase === "settled" &&
      evidence !== undefined &&
      evidence.observed !== evidence.mcp
    )
      return undefined;
    if (evidence !== undefined) {
      for (const text of mcpAttention(evidence)) {
        if (!notices.some((notice) => notice.text === text))
          notices.push({ kind: "warning", text, expandedInResult: true });
      }
      if (
        evidence.unknown > 0 &&
        !notices.some(
          (notice) =>
            notice.text ===
            "MCP execution is uncertain. Check its state; do not replay the operation automatically.",
        )
      )
        notices.push({
          kind: "recovery",
          text: "MCP execution is uncertain. Check its state; do not replay the operation automatically.",
        });
      if (
        evidence.notSent > 0 &&
        !notices.some(
          (notice) => notice.text === `${evidence.notSent} MCP operations were not sent.`,
        )
      )
        notices.push({
          kind: "warning",
          text: `${evidence.notSent} MCP operations were not sent.`,
        });
      if (details.compactAttention === undefined && evidence.mcp > 0 && failed + cancelled > 0)
        notices.push({
          kind: "recovery",
          text: "A nested call did not deliver a successful result to the program. MCP work may already have completed; do not replay it to recover output.",
        });
      if (
        evidence.errors > 0 &&
        !notices.some(
          (notice) =>
            notice.text ===
            `${evidence.errors} MCP operations reported errors. Completed operations must not be replayed to recover output.`,
        )
      )
        notices.push({
          kind: "warning",
          text: `${evidence.errors} MCP operations reported errors. Completed operations must not be replayed to recover output.`,
        });
    }
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
