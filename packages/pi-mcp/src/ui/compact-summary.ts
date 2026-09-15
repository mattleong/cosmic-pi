import type { CompactNotice, CompactSummaryProvider } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import { sanitizeTerminalLine } from "pi-cosmic-core";
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

const searchQuery = <Args>(args: Args): string | undefined => {
  try {
    if (!Predicate.isObjectOrArray(args)) return undefined;
    const field = Object.getOwnPropertyDescriptor(args, "query");
    if (
      !field ||
      !("value" in field) ||
      !Predicate.isString(field.value) ||
      field.value.length > 1024
    )
      return undefined;
    return sanitizeTerminalLine(field.value).trim().slice(0, 160) || undefined;
  } catch {
    return undefined;
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
  const action = call.action;
  const subject =
    action === "tools.search"
      ? [call.target, searchQuery(args)].filter(Boolean).join(" / ")
      : call.target;
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

  const count = card.page
    ? `${card.page.returned}${card.page.total === undefined ? "" : ` of ${card.page.total}`} entries${card.page.hasMore ? ", more available" : ""}`
    : (card.counters[0] ??
      (card.attachmentCount
        ? `${card.attachmentsLimited ? "at least " : ""}${card.attachmentCount} attachments`
        : card.imageCount
          ? `${card.imageCount} native images`
          : undefined));
  const counters = count ? [count] : [];
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
    if (!cleanCompleteOutput)
      notices.push({ kind: "recovery", text: card.recoveryHint, expandedInResult: true });
  }
  if (card.undiscoveredCount)
    notices.push({
      kind: "recovery",
      text: `Discovery is incomplete: ${card.undiscoveredCount} undiscovered servers. Select a server for a targeted list or search.`,
    });
  return {
    action,
    subject,
    counters,
    outcome:
      card.warnings.length || card.notices.length || card.undiscoveredCount ? "warning" : "success",
    notices,
  };
};
