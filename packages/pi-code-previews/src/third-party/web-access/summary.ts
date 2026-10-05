import { countLabel, failureMessage, sanitizeDiagnosticContent } from "pi-cosmic-core";
import type { CompactIssue } from "../../tools/compact-issues";
import type { CompactSummaryProvider } from "../../tools/compact-summary";
import { webAccessArgumentReference, webAccessEvidence, webAccessSubject } from "./evidence";
import type { WebAccessTool } from "./identity";

/** Counts describe delivered evidence, never search quality, claim truth, or recovery availability. */
export function webAccessSummary(name: WebAccessTool): CompactSummaryProvider {
  return ({ phase, args, result }) => {
    const heading = { subject: webAccessSubject(name, args), showTiming: true as const };
    if (!result) return phase === "settled" ? undefined : heading;
    const evidence = webAccessEvidence(name, result.details);
    if (!evidence) return undefined;
    const { details, researchErrors } = evidence;
    const issues: CompactIssue[] = [];
    const error = details.error?.trim();
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
    const failedQueries =
      details.queryCount !== undefined && details.successfulQueries !== undefined
        ? details.queryCount - details.successfulQueries
        : 0;
    const failedUrls =
      details.urlCount !== undefined && details.successful !== undefined
        ? details.urlCount - details.successful
        : 0;
    for (const [count, noun, plural, code] of [
      [failedQueries, "query", "queries", "web-query-failures"],
      [failedUrls, "URL", "URLs", "web-fetch-failures"],
      [
        researchErrors,
        "source-check operation",
        "source-check operations",
        "web-research-failures",
      ],
      [details.unavailable?.length ?? 0, "web capability", "web capabilities", "web-unavailable"],
      [details.missing?.length ?? 0, "web tool", "web tools", "web-missing"],
    ] as const)
      if (count > 0)
        issues.push({
          severity: "warning",
          code,
          message: `${countLabel(count, noun, plural)} failed`,
        });
    if (details.truncated) {
      const reference =
        details.responseId?.trim() ||
        details.searchId?.trim() ||
        (name === "get_search_content" ? webAccessArgumentReference(args) : "");
      issues.push({
        severity: reference ? "info" : "warning",
        code: "web-shortened",
        message: reference
          ? "The output is a bounded excerpt"
          : "The output was shortened without a recovery reference",
        ...(reference && {
          detail: `Stored content reference: ${sanitizeDiagnosticContent(reference)}`,
        }),
      });
    }
    if (phase !== "settled") return { ...heading, issues };
    if (details.cancelled) return { ...heading, outcome: "cancelled", issues };
    if (error) return { ...heading, outcome: "error", issues };
    let counters: string[] | undefined;
    if (
      name === "web_search" &&
      details.queryCount !== undefined &&
      details.successfulQueries !== undefined &&
      details.totalResults !== undefined
    )
      counters = [
        countLabel(details.totalResults, "source"),
        countLabel(details.queryCount, "query", "queries"),
      ];
    else if (
      name === "fetch_content" &&
      details.urlCount !== undefined &&
      details.successful !== undefined
    )
      counters = [
        `${details.successful}/${details.urlCount} URLs`,
        countLabel(details.successful, "URL"),
      ];
    else if (
      name === "source_check" &&
      details.sourceCount !== undefined &&
      details.passageCount !== undefined &&
      details.searchCount !== undefined
    )
      counters = [
        `${countLabel(details.sourceCount, "source")} · ${countLabel(details.passageCount, "passage")}`,
        countLabel(details.sourceCount, "source"),
      ];
    else if (
      name === "get_search_content" &&
      details.matchCount !== undefined &&
      details.returnedMatches !== undefined
    )
      counters = [`${details.returnedMatches}/${details.matchCount} matches`];
    else if (
      name === "get_search_content" &&
      details.returnedChars !== undefined &&
      details.contentLength !== undefined
    )
      counters = [countLabel(details.returnedChars, "character")];
    else if (name === "web_enable" && details.enabled)
      counters = [countLabel(details.enabled.length, "tool")];
    if (!counters) return undefined;
    return { ...heading, counters, outcome: "returned", issues };
  };
}
