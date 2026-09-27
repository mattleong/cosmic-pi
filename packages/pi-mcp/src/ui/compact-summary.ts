import {
  compactIssueSeverity,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";
import { ownPresentationField } from "../code-mode/presentation-evidence.ts";

const searchQuery = <Args>(args: Args): string | undefined => {
  const query = ownPresentationField(args, "query").value;
  return Predicate.isString(query) && query.length <= 1024
    ? sanitizeDiagnosticContent(sanitizeTerminalLine(query), { maximumLength: 160 }).trim() ||
        undefined
    : undefined;
};

/** Issues come from the shared presentation projection; expansion shows the labeled raw result. */
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
}): CompactSummary | undefined => {
  const call = mcpCallSummary(args);
  const action = call.action;
  const heading = {
    action,
    subject:
      action === "tools.search"
        ? [call.target, searchQuery(args)].filter(Boolean).join(" / ")
        : call.target,
    ...(action === "result.read" && { compactSubject: "Saved output" }),
  };
  if (phase !== "settled") return isError ? undefined : heading;

  const card = decodeMcpCardDetails(result);
  // Notices beyond the issue budget are listed only by the detailed card.
  if (card.notices.join("\n").length > 2048) return undefined;
  const issues = card.presentation.issues;
  const boundary = card.action === action ? card.boundary : undefined;
  if (boundary)
    return {
      ...heading,
      outcome: boundary.outcome,
      counters: [boundary.status.toLowerCase()],
      // Sign-in is the user's own action, so the message says how to take it.
      issues:
        boundary.signIn && call.server
          ? issues.map((issue) =>
              issue.code === "boundary-failure"
                ? { ...issue, message: `Sign-in required: /mcp auth ${call.server}` }
                : issue,
            )
          : issues,
    };
  // Unknown envelopes, incomplete evidence, and unviewed adapter failures keep the detailed card.
  if (
    !card.known ||
    card.presentation.incomplete ||
    card.diagnostic ||
    (isError && !card.presentation.isError)
  )
    return undefined;

  const retainedRead =
    card.action === "result.read" &&
    action === "result.read" &&
    card.retainedPage !== undefined &&
    !card.isError &&
    !isError;
  const count =
    retainedRead && card.retainedPage
      ? `page ${card.retainedPage.offset}..${card.retainedPage.end}/${card.retainedPage.total}${card.retainedPage.next === null ? " · EOF" : ""}`
      : card.page
        ? `${card.page.returned}${card.page.total === undefined ? "" : ` of ${card.page.total}`} entries${card.page.hasMore ? ", more available" : ""}`
        : (card.counts[0] ??
          (card.attachmentCount
            ? `${card.attachmentsLimited ? "at least " : ""}${card.attachmentCount} attachments`
            : card.imageCount
              ? `${card.imageCount} native images`
              : undefined));
  return {
    ...heading,
    counters: count ? [count] : [],
    outcome:
      (retainedRead ? card.outcome : card.presentation.outcome) === "unknown"
        ? "uncertain"
        : isError || (card.presentation.isError && !retainedRead)
          ? "error"
          : compactIssueSeverity(issues)
            ? "warning"
            : "success",
    issues,
  };
};

export const mcpCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  phase,
  args,
  result,
  context,
}) => projectMcpCompactSummary({ phase, args, result, isError: context.isError });
