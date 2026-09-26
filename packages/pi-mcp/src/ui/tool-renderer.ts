import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
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
    !details.presentation.issues.entries.some((issue) => issue.code === "retained-output")
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

export const renderMcpResult = <Result>(
  result: Result,
  options: { readonly expanded: boolean; readonly isPartial: boolean; readonly isError?: boolean },
  theme: CardTheme,
  expandHint = "",
): Component => {
  const details = decodeMcpCardDetails(result);
  const boundary = options.expanded && !options.isPartial ? details.boundary : undefined;
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
    if (details.diagnostic && !options.isPartial && !boundary)
      lines.push(theme.fg("muted", details.diagnostic.title));
    const counts = [...details.counts];
    if (details.attachmentCount)
      counts.push(
        `${details.attachmentsLimited ? "at least " : ""}${details.attachmentCount} attachments`,
      );
    if (details.imageCount) counts.push(`${details.imageCount} native images`);
    if (counts.length) lines.push(theme.fg("muted", counts.join(" · ")));
    if (boundary) {
      // The same identified issues back the compact summary. The shell can yield
      // ownership per issue without treating this as complete diagnostic coverage.
      for (const issue of boundary.issues.entries) {
        if (issue.cause) lines.push(theme.fg(issue.severity, issue.cause));
        for (const recovery of issue.recovery) lines.push(theme.fg("warning", recovery.text));
        for (const detail of issue.diagnostics ?? []) lines.push(theme.fg("muted", detail));
      }
      lines.push(renderExpansionAffordance("Existing details", true, theme, expandHint));
      lines.push(theme.fg("toolOutput", details.preview));
      return new Text(lines.join("\n"), 0, 0).render(Math.floor(width));
    }
    // Failed calls use this renderer even in compact mode. Keep the bounded,
    // sanitized error body visible rather than requiring expansion to find the cause.
    if (failed && !options.isPartial && !options.expanded)
      lines.push(theme.fg("error", details.failurePreview));
    // Safety warnings wrap rather than clip. Collapse must not conceal uncertainty.
    for (const warning of details.warnings) lines.push(toolStatusLine(theme, "warning", warning));
    if (details.recoveryHint && !details.resultId)
      lines.push(theme.fg("accent", details.recoveryHint));
    lines.push(renderExpansionAffordance("Existing details", options.expanded, theme, expandHint));
    if (options.expanded) {
      if (details.recoveryHint && details.resultId)
        lines.push(theme.fg("accent", details.recoveryHint));
      if (details.diagnostic && !details.warnings.includes(details.diagnostic.explanation))
        lines.push(theme.fg("muted", details.diagnostic.explanation));
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
      for (const notice of details.notices) {
        if (!details.warnings.includes(notice)) lines.push(theme.fg("muted", notice));
      }
      lines.push(theme.fg("toolOutput", details.preview));
    }
    return new Text(lines.join("\n"), 0, 0).render(Math.floor(width));
  });
};
