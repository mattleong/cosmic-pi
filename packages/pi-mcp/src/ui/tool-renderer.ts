import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import { decodeMcpCardDetails, mcpCallSummary } from "./tool-render-details.ts";

type CardTheme = Pick<Theme, "fg" | "bold">;
export const renderMcpCall = <Args>(args: Args, theme: CardTheme): Component => {
  const call = mcpCallSummary(args);
  return composeToolComponent((width) =>
    Number.isFinite(width) && width >= 1
      ? new Text(
          renderToolHeader({ title: `MCP ${call.action}`, subtitle: call.target }, theme),
          0,
          0,
        ).render(Math.floor(width))
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
  return composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const lines: string[] = [];
    const failed = details.isError || options.isError === true;
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
    lines.push(toolStatusLine(theme, status, label));
    if (details.diagnostic && !options.isPartial)
      lines.push(theme.fg("muted", details.diagnostic.title));
    const counts = [...details.counts];
    if (details.attachmentCount)
      counts.push(
        `${details.attachmentsLimited ? "at least " : ""}${details.attachmentCount} attachments`,
      );
    if (details.imageCount) counts.push(`${details.imageCount} native images`);
    if (counts.length) lines.push(theme.fg("muted", counts.join(" · ")));
    // Safety warnings wrap rather than clip. Collapse must not conceal uncertainty.
    for (const warning of details.warnings) lines.push(toolStatusLine(theme, "warning", warning));
    if (details.recoveryHint) lines.push(theme.fg("accent", details.recoveryHint));
    lines.push(renderExpansionAffordance("Existing details", options.expanded, theme, expandHint));
    if (options.expanded) {
      if (details.diagnostic && !details.warnings.includes(details.diagnostic.explanation))
        lines.push(theme.fg("muted", details.diagnostic.explanation));
      if (details.origin) {
        const origin = details.origin;
        const outcome = origin.outcome ?? "outcome unavailable";
        const failure =
          origin.isError || origin.outputValidationFailed ? "failure" : "no failure reported";
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
