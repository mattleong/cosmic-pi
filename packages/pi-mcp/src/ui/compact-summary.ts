import {
  compactIssueSeverity,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { withSignInCommand } from "./boundary-failure.ts";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";
import { countLabel } from "pi-cosmic-core";

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
  const heading = { action, subject: call.target };
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
      issues: [...withSignInCommand(issues, boundary, call.server)],
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
        ? `${card.page.total === undefined ? countLabel(card.page.returned, "entry", "entries") : `${card.page.returned} of ${countLabel(card.page.total, "entry", "entries")}`}${card.page.hasMore ? ", more available" : ""}`
        : (card.counts[0] ??
          (card.attachmentCount
            ? `${card.attachmentsLimited ? "at least " : ""}${countLabel(card.attachmentCount, "attachment")}`
            : card.imageCount
              ? countLabel(card.imageCount, "image")
              : undefined));
  // A reply marked as an error for a reason stated only as a warning, such as unsaved or
  // unchecked output, explains itself with that reason rather than a generic line.
  const failed = isError || (card.presentation.isError && !retainedRead);
  const firstWarning = issues.findIndex((issue) => issue.severity === "warning");
  const explained =
    failed && compactIssueSeverity(issues) === "warning"
      ? issues.map((issue, index) =>
          index === firstWarning ? { ...issue, severity: "error" as const } : issue,
        )
      : issues;
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
    issues: explained,
  };
};

export const mcpCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  phase,
  args,
  result,
  context,
}) => projectMcpCompactSummary({ phase, args, result, isError: context.isError });
