import {
  resolveCompactSummary,
  toolErrorIssue,
  type CompactPhase,
  type CompactSummary,
} from "./compact-summary";

type CompactHeading = Pick<
  CompactSummary,
  "subject" | "compactSubject" | "action" | "showTiming" | "showShortTiming"
>;

export function planCompactPresentation(input: {
  summary: CompactSummary | undefined;
  phase: CompactPhase;
  isError: boolean;
  errorText?: string;
  expanded?: boolean;
  heading?: CompactHeading | undefined;
}) {
  const summary = resolveCompactSummary(input.summary, input.phase, input.isError, input.errorText);
  const heading = fallbackHeading(input.heading);
  if (summary || input.phase !== "settled")
    return { summary, collapsedSummary: summary ?? heading };
  const collapsedSummary: CompactSummary = input.isError
    ? { ...heading, outcome: "error", issues: [toolErrorIssue(input.errorText ?? "")] }
    : {
        ...heading,
        outcome: "uncertain",
        ...(!input.expanded && { metadata: ["details on expand"] }),
      };
  return { summary, collapsedSummary };
}

function fallbackHeading(heading: CompactHeading | undefined): CompactSummary {
  return {
    subject: heading?.subject ?? "",
    ...(heading?.compactSubject !== undefined && { compactSubject: heading.compactSubject }),
    ...(heading?.action !== undefined && { action: heading.action }),
    ...(heading?.showTiming && { showTiming: true }),
    ...(heading?.showShortTiming && { showShortTiming: true }),
  };
}
