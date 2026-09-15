/** Pure Code Mode projection for the opt-in shared compact shell. */
import * as Schema from "effect/Schema";
import type { CompactNotice, CompactSummaryProvider } from "pi-code-previews";
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
    // Adapter Promises can fulfill with domain failures or unknown execution. Their payload
    // outcomes are not retained here. Hidden call history could contain those adapters too.
    // Preserve the original result instead of turning interpreter completion into success.
    if (
      total !== details.toolCalls.length ||
      details.toolCalls.some((call) => !call.tool.startsWith("pi."))
    )
      return undefined;
    // outputKind is emitted only by the owned successful execution path, unlike isError=false.
    if (details.outputKind === undefined) return undefined;
    return {
      subject,
      counters: [`${total} ${total === 1 ? "call" : "calls"}`],
      notices,
      outcome: failed + cancelled > 0 || details.truncated ? "warning" : "success",
    };
  } catch {
    return undefined;
  }
};
