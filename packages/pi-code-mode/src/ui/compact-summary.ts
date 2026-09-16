/** Pure Code Mode projection for the opt-in shared compact shell. */
import * as Schema from "effect/Schema";
import {
  isCompactAttention,
  selectCompactChildren,
  type CompactChild,
  type CompactNotice,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { INCOMPLETE_ATTENTION } from "../tools/compact-evidence.ts";
import { isCompactPiTool, mcpAttention } from "../tools/mcp-evidence.ts";
import { decodeOption, type CodeModeCallEntry } from "../tools/format.ts";
import { decodeCodeModeRenderDetails } from "./tool-render-details.ts";
import { describeCodeModeIntent } from "./tool-renderer.ts";

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
    const counters = [`${succeeded + failed + cancelled}/${total} done`];
    const children = {
      total,
      entries: details.toolCalls.map((call): CompactChild => {
        const durationMs =
          call.status === "running"
            ? phase === "running"
              ? liveElapsed?.(call)
              : undefined
            : call.status === "queued"
              ? undefined
              : call.durationMs;
        return {
          label: isCompactPiTool(call.tool)
            ? call.tool.slice(3)
            : call.compact !== undefined && call.tool === "mcp.request"
              ? "mcp"
              : call.compact !== undefined && call.tool === "session.backgroundTask"
                ? "background_task"
                : call.tool,
          ...(call.subject !== undefined && { subject: call.subject }),
          ...(call.compact !== undefined && {
            subject: call.compact.subject,
            ...(call.compact.action !== undefined && { action: call.compact.action }),
            ...(call.compact.counters !== undefined && { counters: call.compact.counters }),
            ...(call.compact.metadata !== undefined && { metadata: call.compact.metadata }),
            notices: call.compact.notices,
          }),
          ...(durationMs !== undefined && { durationMs }),
          // Delivery failure takes precedence over a successful operation receipt.
          status: call.compact?.deliveryFailed
            ? call.compact.outcome === "uncertain"
              ? "uncertain"
              : "error"
            : call.status === "completed"
              ? (call.compact?.outcome ??
                (isCompactPiTool(call.tool) && details.compactAttention === undefined
                  ? "success"
                  : "returned"))
              : call.status === "queued" || call.status === "running"
                ? phase === "settled"
                  ? "uncertain"
                  : call.status === "queued"
                    ? "pending"
                    : "running"
                : call.status,
        };
      }),
    };
    const notices: CompactNotice[] = (details.compactAttention?.notices ?? []).map((notice) => ({
      ...notice,
      expandedInResult: true,
    }));
    // The owned outer-failure shell bypasses the detailed renderer. Keep retained
    // informational hints parent-owned there, too, even for visible children.
    for (const call of details.toolCalls) {
      for (const notice of call.compact?.notices ?? []) {
        if (
          !isCompactAttention(notice) &&
          !notices.some(
            (existing) => existing.kind === notice.kind && existing.text === notice.text,
          )
        )
          notices.push({ ...notice, expandedInResult: true });
      }
    }
    if (details.compactAttention?.incomplete)
      notices.push({ kind: "warning", text: INCOMPLETE_ATTENTION, expandedInResult: true });
    if (failed > 0) notices.push({ kind: "warning", text: `${failed} nested operations failed.` });
    if (cancelled > 0)
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
      if (evidence.mcp > 0 && failed + cancelled > 0)
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
      // Retained Code Mode failure content is complete model-visible diagnostic text. Keep
      // every continuation visible as recovery evidence rather than classify arbitrary prose.
      const [first = "", ...rest] = text.split("\n");
      if (rest.some((line) => line.trim().length > 0))
        notices.push({ kind: "recovery", text: rest.join("\n") });
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
        ...(text.length > 0 && { failure: { cause: first, details: text } }),
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
      counters: [`${total} ${total === 1 ? "tool" : "tools"}`],
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
