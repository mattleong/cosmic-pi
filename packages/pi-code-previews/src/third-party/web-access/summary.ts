import { countLabel, failureMessage, sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CompactIssue } from "../../tools/compact-issues";
import type { CompactSummaryProvider } from "../../tools/compact-summary";
import {
  webAccessArgumentReference,
  webAccessEvidence,
  webAccessSubject,
  type WebAccessDetails,
} from "./evidence";
import type { WebAccessTool } from "./identity";

function reportedIssues(details: WebAccessDetails, error: string | undefined): CompactIssue[] {
  const issues: CompactIssue[] = [];
  if (error && !details.cancelled)
    issues.push({
      severity: "error",
      code: "web-error",
      message: failureMessage(error, "The web tool reported an error"),
      detail: sanitizeDiagnosticContent(error),
    });
  if (details.browserOpenError?.trim())
    issues.push({
      severity: "warning",
      code: "web-browser",
      message: "The search curator couldn't open automatically",
      detail: sanitizeDiagnosticContent(details.browserOpenError),
    });
  return issues;
}

const shortfall = (total: number | undefined, succeeded: number | undefined): number =>
  total !== undefined && succeeded !== undefined ? total - succeeded : 0;

function failureIssues(details: WebAccessDetails, researchErrors: number): CompactIssue[] {
  const failures = [
    [
      shortfall(details.queryCount, details.successfulQueries),
      "query",
      "queries",
      "web-query-failures",
    ],
    [shortfall(details.urlCount, details.successful), "URL", "URLs", "web-fetch-failures"],
    [researchErrors, "source-check operation", "source-check operations", "web-research-failures"],
    [details.unavailable?.length ?? 0, "web capability", "web capabilities", "web-unavailable"],
    [details.missing?.length ?? 0, "web tool", "web tools", "web-missing"],
  ] as const;
  return failures.flatMap(([count, noun, plural, code]): CompactIssue[] =>
    count > 0
      ? [{ severity: "warning", code, message: `${countLabel(count, noun, plural)} failed` }]
      : [],
  );
}

function truncationIssues<Args>(
  name: WebAccessTool,
  args: Args,
  details: WebAccessDetails,
): CompactIssue[] {
  if (!details.truncated) return [];
  const reference =
    details.responseId?.trim() ||
    details.searchId?.trim() ||
    (name === "get_search_content" ? webAccessArgumentReference(args) : "");
  return [
    {
      severity: reference ? "info" : "warning",
      code: "web-shortened",
      message: reference
        ? "The output is a bounded excerpt"
        : "The output was shortened without a recovery reference",
      ...(reference && {
        detail: `Stored content reference: ${sanitizeDiagnosticContent(reference)}`,
      }),
    },
  ];
}

function storedContentCounters(details: WebAccessDetails): string[] | undefined {
  const { matchCount, returnedMatches, returnedChars, contentLength } = details;
  if (matchCount !== undefined && returnedMatches !== undefined)
    return [`${returnedMatches}/${matchCount} matches`];
  if (returnedChars !== undefined && contentLength !== undefined)
    return [countLabel(returnedChars, "character")];
  return undefined;
}

const COUNTERS = {
  web_search: ({ queryCount, successfulQueries, totalResults }) =>
    queryCount !== undefined && successfulQueries !== undefined && totalResults !== undefined
      ? [countLabel(totalResults, "source"), countLabel(queryCount, "query", "queries")]
      : undefined,
  fetch_content: ({ urlCount, successful }) =>
    urlCount !== undefined && successful !== undefined
      ? [`${successful}/${urlCount} URLs`, countLabel(successful, "URL")]
      : undefined,
  source_check: ({ sourceCount, passageCount, searchCount }) =>
    sourceCount !== undefined && passageCount !== undefined && searchCount !== undefined
      ? [
          `${countLabel(sourceCount, "source")} · ${countLabel(passageCount, "passage")}`,
          countLabel(sourceCount, "source"),
        ]
      : undefined,
  get_search_content: storedContentCounters,
  web_enable: ({ enabled }) => (enabled ? [countLabel(enabled.length, "tool")] : undefined),
} satisfies Record<WebAccessTool, (details: WebAccessDetails) => string[] | undefined>;

export function webAccessSummary(name: WebAccessTool): CompactSummaryProvider {
  return ({ phase, args, result }) => {
    const heading = { subject: webAccessSubject(name, args), showTiming: true as const };
    if (!result) return phase === "settled" ? undefined : heading;
    const evidence = webAccessEvidence(name, result.details);
    if (!evidence) return undefined;
    const { details } = evidence;
    const error = details.error?.trim();
    const issues = [
      ...reportedIssues(details, error),
      ...failureIssues(details, evidence.researchErrors),
      ...truncationIssues(name, args, details),
    ];
    if (phase !== "settled") return { ...heading, issues };
    if (details.cancelled) return { ...heading, outcome: "cancelled", issues };
    if (error) return { ...heading, outcome: "error", issues };
    const counters = COUNTERS[name](details);
    if (!counters) return undefined;
    return { ...heading, counters, outcome: "returned", issues };
  };
}
