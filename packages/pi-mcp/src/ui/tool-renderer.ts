import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { renderCompactIssues } from "pi-code-previews";
import { withSignInCommand } from "./boundary-failure.ts";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import { renderMcpCallContent } from "./call-content.ts";
import { progressLabel } from "./remote-events.ts";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";

type CardTheme = Pick<Theme, "fg" | "bold">;

/** Compact expansion owns content only. The shell renders status and semantic attention. */
export const renderMcpExpandedContent = <Result>(
  result: Result,
  _options: { readonly expanded: boolean; readonly isPartial: boolean },
  theme: CardTheme,
): Component => {
  const details = decodeMcpCardDetails(result);
  const navigation =
    details.recoveryHint &&
    !details.boundary &&
    !details.presentation.issues.some((issue) => issue.code === "retained-output")
      ? `${theme.fg("accent", details.recoveryHint)}\n`
      : "";
  return new Text(navigation + theme.fg("toolOutput", details.preview), 0, 0);
};
export const renderMcpCall = <Args>(args: Args, theme: CardTheme, expanded = false): Component => {
  const call = mcpCallSummary(args);
  return composeToolComponent((width) =>
    Number.isFinite(width) && width >= 1
      ? [
          ...new Text(
            renderToolHeader({ title: `MCP ${call.action}`, subtitle: call.target }, theme),
            0,
            0,
          ).render(Math.floor(width)),
          ...(expanded ? renderMcpCallContent(args, theme).render(Math.floor(width)) : []),
        ]
      : [],
  );
};

/** The detailed card renders its own issues: the shared shell shows none alongside it. */
export const renderMcpResult = <Result>(
  result: Result,
  options: {
    readonly expanded: boolean;
    readonly isPartial: boolean;
    readonly isError?: boolean;
    /** The call's server, which names the sign-in command when signing in is the remedy. */
    readonly server?: string | undefined;
  },
  theme: Theme,
  expandHint = "",
): Component => {
  const details = decodeMcpCardDetails(result);
  const boundary = options.expanded && !options.isPartial ? details.boundary : undefined;
  // Progress updates are not settled; their provisional uncertainty is not an issue yet.
  const issues = options.isPartial
    ? []
    : withSignInCommand(details.presentation.issues, details.boundary, options.server);
  const issueDetails = issues.flatMap((issue) => issue.detail?.split("\n") ?? []);
  const repeated = (text: string) => issueDetails.includes(text);
  // A boundary issue carries the diagnostic title, explanation, and navigation in its detail.
  const boundaryIssue = issues.some((issue) => issue.code === "boundary-failure");
  return composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const lines: string[] = [];
    const failed = details.presentation.isError || options.isError === true;
    const status = options.isPartial
      ? "running"
      : details.outcome === "unknown" || details.outcome === "not-sent"
        ? "warning"
        : failed
          ? "failed"
          : details.known
            ? "done"
            : "info";
    const label = options.isPartial
      ? "In progress"
      : !details.known
        ? failed
          ? "Failed; execution details unavailable"
          : "Execution details unavailable"
        : details.outcome === "unknown"
          ? "Outcome unknown"
          : details.outcome === "not-sent"
            ? "Not sent"
            : failed
              ? "Completed with a problem"
              : "Completed";
    lines.push(toolStatusLine(theme, status, boundary?.status ?? label));
    const progress = options.isPartial ? progressLabel(result) : undefined;
    if (progress) lines.push(theme.fg("muted", progress));
    if (details.diagnostic && !options.isPartial && !boundaryIssue)
      lines.push(theme.fg("muted", details.diagnostic.title));
    const counts = [...details.counts];
    if (details.attachmentCount)
      counts.push(
        `${details.attachmentsLimited ? "at least " : ""}${details.attachmentCount} attachments`,
      );
    if (details.imageCount) counts.push(`${details.imageCount} native images`);
    if (counts.length) lines.push(theme.fg("muted", counts.join(" · ")));
    const rest: string[] = [];
    // Failed calls use this renderer even in compact mode. Keep the bounded, sanitized error
    // body visible rather than require expansion, unless a remote-failure issue states it.
    if (
      failed &&
      !options.isPartial &&
      !options.expanded &&
      !issues.some((issue) => issue.code === "remote-failure")
    )
      rest.push(theme.fg("error", details.failurePreview));
    if (details.recoveryHint && !details.resultId && !repeated(details.recoveryHint))
      rest.push(theme.fg("accent", details.recoveryHint));
    rest.push(renderExpansionAffordance("Existing details", options.expanded, theme, expandHint));
    if (options.expanded) {
      if (details.recoveryHint && details.resultId && !repeated(details.recoveryHint))
        rest.push(theme.fg("accent", details.recoveryHint));
      if (details.diagnostic && !repeated(details.diagnostic.explanation))
        rest.push(theme.fg("muted", details.diagnostic.explanation));
      // Display cuts can hide an adapter message that fixed boundary issues never repeat.
      if (details.errorMessage && details.displayCuts.length && !repeated(details.errorMessage))
        rest.push(theme.fg("muted", details.errorMessage));
      if (details.origin) {
        const origin = details.origin;
        const outcome = origin.outcome ?? "outcome unavailable";
        const failure =
          origin.isError || origin.outputValidationFailed
            ? "failure"
            : origin.outputValidationUnavailable
              ? "output validation unavailable"
              : "no failure reported";
        rest.push(theme.fg("muted", `Origin: ${origin.action} · ${outcome} · ${failure}`));
      }
      // Notices beyond the issue budget remain listed here.
      for (const notice of details.notices)
        if (!repeated(notice)) rest.push(theme.fg("muted", notice));
      rest.push(theme.fg("toolOutput", details.preview));
    }
    const text = (block: string[]) => new Text(block.join("\n"), 0, 0).render(Math.floor(width));
    return [
      ...text(lines),
      ...renderCompactIssues(issues, theme, Math.floor(width), options.expanded, ""),
      ...text(rest),
    ];
  });
};
