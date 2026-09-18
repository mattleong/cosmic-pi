import {
  isCompactAttention,
  type CompactNotice,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { classifyMcpDiscoveryNotice } from "../discovery/diagnostics.ts";
import * as Predicate from "effect/Predicate";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";

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
    return (
      sanitizeDiagnosticContent(sanitizeTerminalLine(field.value), { maximumLength: 160 }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
};

/** Only complete producer evidence may replace the original collapsed card. */
export const projectMcpCompactSummary = ({
  phase,
  args,
  result,
  isError,
}: {
  phase: "pending" | "running" | "settled";
  args: unknown;
  result: { details?: unknown } | undefined;
  isError: boolean;
}): import("pi-code-previews").CompactSummary | undefined => {
  const call = mcpCallSummary(args);
  const action = call.action;
  const subject =
    action === "tools.search"
      ? [call.target, searchQuery(args)].filter(Boolean).join(" / ")
      : call.target;
  if (phase !== "settled") return isError ? undefined : { action, subject };

  const card = decodeMcpCardDetails(result);
  // The original card retains unknown diagnostics and its sanitized remote error body.
  if (
    !card.known ||
    card.presentation.incomplete ||
    card.diagnostic ||
    (isError && !card.presentation.isError) ||
    (card.presentation.isError && card.presentation.issues.coverage !== "complete")
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
  const notices: CompactNotice[] = [...new Set([...card.warnings, ...card.notices])].map((text) => {
    const policy = classifyMcpDiscoveryNotice({
      action: card.action ?? "",
      outcome: card.outcome ?? "unknown",
      isError: card.isError,
      notice: text,
    });
    return policy.visibility === "expanded-only"
      ? {
          code: "discovery-information",
          kind: "recovery",
          text,
          expandedOnly: true,
          expandedInResult: true,
        }
      : { kind: "warning", text, expandedInResult: true };
  });
  return {
    action,
    subject,
    counters,
    outcome:
      isError || card.presentation.isError
        ? "error"
        : card.presentation.outcome === "unknown"
          ? "uncertain"
          : notices.some(isCompactAttention) || card.presentation.issues.entries.length
            ? "warning"
            : "success",
    notices,
    issues: card.presentation.issues,
    detailsOnExpand: true,
  };
};

export const mcpCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  phase,
  args,
  result,
  context,
}) => projectMcpCompactSummary({ phase, args, result, isError: context.isError });
