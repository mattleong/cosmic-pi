import { resolveCompactSummary, type CompactPhase, type CompactSummary } from "./compact-summary";
import { failureMessage } from "pi-cosmic-core";

/**
 * Shared display policy only. Domain outcome classification stays with the producer.
 * Without a usable summary, the heading comes from the arguments and the row states only
 * what Pi reported: an error explains itself with its first line; anything else is unconfirmed.
 */
export function planCompactPresentation(input: {
  summary: CompactSummary | undefined;
  phase: CompactPhase;
  isError: boolean;
  errorText?: string;
  /** Expanded views already show the details, so they get no "details on expand" hint. */
  expanded?: boolean;
  heading?:
    | Pick<CompactSummary, "subject" | "compactSubject" | "action" | "showTiming">
    | undefined;
}) {
  const summary = resolveCompactSummary(input.summary, input.phase, input.isError, input.errorText);
  if (summary || input.phase !== "settled")
    return { summary, collapsedSummary: summary ?? fallbackHeading(input.heading) };
  const heading = fallbackHeading(input.heading);
  const collapsedSummary: CompactSummary = input.isError
    ? {
        ...heading,
        outcome: "error",
        issues: [
          {
            severity: "error",
            code: "tool-error",
            message: failureMessage(input.errorText ?? "", "The tool reported an error"),
          },
        ],
      }
    : {
        ...heading,
        outcome: "uncertain",
        ...(!input.expanded && { metadata: ["details on expand"] }),
      };
  return { summary, collapsedSummary };
}

function fallbackHeading(
  heading: Pick<CompactSummary, "subject" | "compactSubject" | "action" | "showTiming"> | undefined,
): CompactSummary {
  return {
    subject: heading?.subject ?? "",
    ...(heading?.compactSubject !== undefined && { compactSubject: heading.compactSubject }),
    ...(heading?.action !== undefined && { action: heading.action }),
    ...(heading?.showTiming && { showTiming: true }),
  };
}
