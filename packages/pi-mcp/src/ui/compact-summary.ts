import type { CompactNotice, CompactSummaryProvider } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";

// The existing card decoder defaults a missing origin error flag to false.
// Compact success needs explicit evidence instead. Never invoke historical getters.
const explicitOriginSuccess = <Value>(value: Value): boolean => {
  let current: unknown = value;
  try {
    for (const key of ["details", "data", "origin", "isError"]) {
      if (!Predicate.isObjectOrArray(current)) return false;
      const field = Object.getOwnPropertyDescriptor(current, key);
      if (!field || !("value" in field)) return false;
      current = field.value;
    }
    return current === false;
  } catch {
    return false;
  }
};

/** Display-only opt-in. Failures keep the existing renderer, including remote recovery details. */
export const mcpCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  phase,
  args,
  result,
  context,
}) => {
  const call = mcpCallSummary(args);
  const subject = call.target;
  const action = call.action;
  if (phase !== "settled") return context.isError ? undefined : { action, subject };

  const card = decodeMcpCardDetails(result);
  // A resolved Pi call is not evidence of remote success. Historical, unknown,
  // not-sent and failed replies remain unowned, never flattened into a cause.
  if (context.isError || !card.known || card.outcome !== "completed" || card.isError)
    return undefined;
  if (
    card.origin &&
    (card.origin.outcome !== "completed" ||
      card.origin.isError ||
      card.origin.outputValidationFailed ||
      !explicitOriginSuccess(result))
  )
    return undefined;

  const metadata = [...card.metadata];
  const counters = [...card.counters];
  if (card.attachmentCount)
    counters.push(
      `${card.attachmentsLimited ? "at least " : ""}${card.attachmentCount} attachments`,
    );
  if (card.imageCount) counters.push(`${card.imageCount} native images`);
  const notices: CompactNotice[] = [...new Set([...card.warnings, ...card.notices])].map(
    (text) => ({ kind: "warning", text, expandedInResult: true }),
  );
  if (card.recoveryHint) {
    const cleanCompleteOutput =
      card.resultId !== undefined &&
      !card.diagnostic &&
      !notices.length &&
      !card.truncated &&
      !card.displayCuts.length &&
      !card.attachmentsLimited &&
      !card.undiscoveredCount &&
      !(
        card.page?.total !== undefined &&
        card.page.returned < card.page.total &&
        !card.page.hasMore
      );
    if (cleanCompleteOutput) {
      if (call.action !== "result.read" || call.target !== card.resultId)
        metadata.push(`retained ${card.resultId}`);
    } else notices.push({ kind: "recovery", text: card.recoveryHint, expandedInResult: true });
  }
  if (card.undiscoveredCount)
    notices.push({
      kind: "recovery",
      text: "Discovery is incomplete. Select an undiscovered server for a targeted list or search.",
    });
  return {
    action,
    subject,
    counters,
    metadata,
    outcome:
      card.warnings.length || card.notices.length || card.undiscoveredCount ? "warning" : "success",
    notices,
  };
};
