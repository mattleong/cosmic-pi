import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { withSignInCommand } from "./boundary-failure.ts";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
} from "pi-cosmic-ui/tool";
import { renderMcpCallContent } from "./call-content.ts";
import { progressLabel } from "./remote-events.ts";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";
import { countLabel } from "pi-cosmic-core";

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
            renderToolHeader(
              { title: "MCP", subtitle: [call.action, call.target].filter(Boolean).join(" ") },
              theme,
            ),
            0,
            0,
          ).render(Math.floor(width)),
          ...(expanded ? renderMcpCallContent(args, theme).render(Math.floor(width)) : []),
        ]
      : [],
  );
};

/**
 * The preview body under the shell's heading and issues: remote progress while running,
 * routine counts, and once expanded the recovery hint, origin, notices, and labeled raw result.
 */
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
  // Issue details are already shown by the shell; expansion lists only what they leave out.
  const issues = options.isPartial
    ? []
    : withSignInCommand(details.presentation.issues, details.boundary, options.server);
  const issueDetails = issues.flatMap((issue) => [
    issue.message,
    ...(issue.detail?.split("\n") ?? []),
  ]);
  const repeated = (text: string) => issueDetails.includes(text);
  return composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const lines: string[] = [];
    if (options.isPartial) {
      const progress = progressLabel(result);
      lines.push(progress ? theme.fg("muted", progress) : toolRunningLine(theme));
    }
    const counts = [...details.counts];
    if (details.attachmentCount)
      counts.push(
        `${details.attachmentsLimited ? "at least " : ""}${countLabel(details.attachmentCount, "attachment")}`,
      );
    if (details.imageCount) counts.push(countLabel(details.imageCount, "image"));
    if (counts.length) lines.push(theme.fg("muted", counts.join(" · ")));
    if (!options.isPartial)
      lines.push(renderExpansionAffordance("details", options.expanded, theme, expandHint));
    if (options.expanded && !options.isPartial) {
      if (details.recoveryHint && !repeated(details.recoveryHint))
        lines.push(theme.fg("muted", details.recoveryHint));
      if (details.diagnostic && !repeated(details.diagnostic.explanation))
        lines.push(theme.fg("muted", details.diagnostic.explanation));
      // Display cuts can hide an adapter message that fixed boundary issues never repeat.
      if (details.errorMessage && details.displayCuts.length && !repeated(details.errorMessage))
        lines.push(theme.fg("muted", details.errorMessage));
      if (details.origin) {
        const origin = details.origin;
        const outcome = origin.outcome ?? "outcome unavailable";
        const failure =
          origin.isError || origin.outputValidationFailed
            ? "failure"
            : origin.outputValidationUnavailable
              ? "output validation unavailable"
              : "no failure reported";
        lines.push(theme.fg("muted", `Origin: ${origin.action} · ${outcome} · ${failure}`));
      }
      // Notices beyond the issue budget remain listed here.
      for (const notice of details.notices)
        if (!repeated(notice)) lines.push(theme.fg("muted", notice));
      lines.push(theme.fg("toolOutput", details.preview));
    }
    return new Text(lines.join("\n"), 0, 0).render(Math.floor(width));
  });
};
