/** Pure Code Mode projection for the opt-in shared compact shell. */
import * as Schema from "effect/Schema";
import type { CompactNotice, CompactSummaryProvider } from "pi-code-previews";
import { isCompactPiTool } from "../tools/mcp-evidence.ts";
import { decodeOption } from "../tools/format.ts";
import { decodeCodeModeRenderDetails } from "./tool-render-details.ts";
import { describeCodeModeIntent } from "./tool-renderer.ts";

const ArgsSchema = Schema.Struct({ intent: Schema.optional(Schema.Unknown) });
const TextContentSchema = Schema.Array(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

export const codeModeCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  phase,
  args,
  result,
  context,
}) => {
  try {
    const subject = describeCodeModeIntent(decodeOption(ArgsSchema, args)?.intent);
    if (result === undefined) return phase === "settled" ? undefined : { subject };
    const details = decodeCodeModeRenderDetails(result.details);
    if (!details.compactEligible) return undefined;
    const { total, succeeded, failed, cancelled, running, queued } = details.counts;
    const counters = [`${succeeded + failed + cancelled}/${total} done`];
    const notices: CompactNotice[] = [];
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
    if (phase === "settled" && evidence !== undefined && evidence.observed !== evidence.mcp)
      return undefined;
    if (evidence !== undefined) {
      notices.push(...evidence.notices.map((text) => ({ kind: "warning" as const, text })));
      if (evidence.unknown > 0)
        notices.push({
          kind: "recovery",
          text: "MCP execution is uncertain. Check its state; do not replay the operation automatically.",
        });
      if (evidence.notSent > 0)
        notices.push({
          kind: "warning",
          text: `${evidence.notSent} MCP operations were not sent.`,
        });
      if (evidence.mcp > 0 && failed + cancelled > 0)
        notices.push({
          kind: "recovery",
          text: "A nested call did not deliver a successful result to the program. MCP work may already have completed; do not replay it to recover output.",
        });
      if (evidence.errors > 0)
        notices.push({
          kind: "warning",
          text: `${evidence.errors} MCP operations reported errors. Completed operations must not be replayed to recover output.`,
        });
    }
    if (phase !== "settled") return { subject, counters, notices };
    if (running + queued > 0) {
      notices.push({
        kind: "warning",
        text: "Nested operations have no confirmed settlement. Check their state before retrying.",
      });
      return { subject, counters, notices, outcome: "uncertain" };
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
        subject,
        counters,
        notices,
        outcome: details.cancelled ? "cancelled" : "error",
        ...(text.length > 0 && { failure: { cause: first, details: text } }),
      };
    }
    // Legacy details have no adapter evidence or hidden-call coverage. New evidence must
    // validate completely before reaching this branch; never infer outcomes from guest output.
    if (
      evidence === undefined &&
      (total !== details.toolCalls.length ||
        details.toolCalls.some((call) => !isCompactPiTool(call.tool)))
    )
      return undefined;
    // outputKind is emitted only by the owned successful execution path, unlike isError=false.
    if (details.outputKind === undefined) return undefined;
    return {
      subject,
      counters: [`${total} ${total === 1 ? "tool" : "tools"}`],
      notices,
      detailsOnExpand: true,
      outcome: evidence?.unknown
        ? "uncertain"
        : evidence?.errors || evidence?.notSent
          ? "error"
          : failed + cancelled > 0 || details.truncated || notices.length > 0
            ? "warning"
            : "success",
    };
  } catch {
    return undefined;
  }
};
