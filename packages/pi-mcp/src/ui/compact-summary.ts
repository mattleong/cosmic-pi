import {
  isCompactAttention,
  type CompactNotice,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { classifyMcpDiscoveryNotice } from "../discovery/diagnostics.ts";
import * as Predicate from "effect/Predicate";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";
import { mcpBoundaryFailure } from "./boundary-failure.ts";

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

/** Typed causes may be concise without claiming complete diagnostic or recovery coverage. */
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
  if (phase !== "settled")
    return isError
      ? undefined
      : { action, subject, ...(action === "result.read" && { compactSubject: "Saved output" }) };

  const card = decodeMcpCardDetails(result);
  // The raw card retains notices beyond the semantic issue budget.
  if (card.notices.join("\n").length > 2048) return undefined;
  const boundary = card.action === action ? mcpBoundaryFailure(card) : undefined;
  if (
    boundary &&
    card.presentation.issues.entries.some((issue) => issue.code === "boundary-failure")
  )
    return {
      action,
      subject,
      ...(action === "result.read" && { compactSubject: "Saved output" }),
      outcome: boundary.outcome,
      counters: [boundary.status.toLowerCase()],
      issues: card.presentation.issues,
      detailsOnExpand: true,
    };
  const retainedRead =
    card.action === "result.read" &&
    action === "result.read" &&
    card.retainedPage !== undefined &&
    !card.isError &&
    !isError;
  // The original card retains unknown diagnostics and its sanitized remote error body.
  if (
    !card.known ||
    card.presentation.incomplete ||
    card.diagnostic ||
    (isError && !card.presentation.isError) ||
    (card.presentation.isError && card.presentation.issues.coverage !== "complete" && !retainedRead)
  )
    return undefined;

  const count =
    retainedRead && card.retainedPage
      ? `page ${card.retainedPage.offset}..${card.retainedPage.end}/${card.retainedPage.total}${card.retainedPage.next === null ? " · EOF" : ""}`
      : card.page
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
        }
      : { kind: "warning", text };
  });
  return {
    action,
    subject,
    counters,
    ...(action === "result.read" && { compactSubject: "Saved output" }),
    outcome:
      (retainedRead ? card.outcome : card.presentation.outcome) === "unknown"
        ? "uncertain"
        : isError || (card.presentation.isError && !retainedRead)
          ? "error"
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
