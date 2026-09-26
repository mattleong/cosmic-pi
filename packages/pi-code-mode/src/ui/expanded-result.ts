/** Expanded presentation consumes only retained receipts and host timing snapshots. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  planCompactPresentation,
  renderCompactChildren,
  renderExpandedAttention,
  summaryCompactIssues,
  type CompactSummary,
} from "pi-code-previews";
import type { CodeModeCallEntry } from "../tools/format.ts";
import { codeModeCallRows } from "./call-rows.ts";
import { codeModeOutputText, formatStructuredCodeModeOutput } from "./result-output.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";
import { addCodeModeSection } from "./sections.ts";

export interface ExpandedPresentation {
  /** Common shell supplies heading and attention around this body. */
  readonly contentOnly?: boolean;
  readonly readRequest?: { readonly id: string };
  readonly summary?: CompactSummary | undefined;
  readonly fallbackStatus?: string;
  readonly timingEnabled?: boolean;
  readonly liveElapsed?: ((call: CodeModeCallEntry) => number | undefined) | undefined;
}

export const renderExpandedCodeModeResult = (
  details: CodeModeRenderDetails,
  raw: string,
  isPartial: boolean,
  isError: boolean,
  theme: Theme,
  animationFrame: number,
  presentation: ExpandedPresentation,
): Component => {
  const phase = isPartial ? "running" : "settled";
  const children = {
    total: details.counts.total,
    entries: codeModeCallRows(details, phase, presentation.liveElapsed),
  };
  const { summary } = planCompactPresentation({
    summary: presentation.summary,
    phase,
    isError,
    expanded: true,
  });
  const allIssues = summary ? summaryCompactIssues(summary, true) : undefined;
  // Only this exact outer body can own its copied root/continuation issues.
  // Nested result ownership is unrelated and must not erase independent recovery.
  const claims =
    !isPartial && raw === summary?.failure?.details ? summary.failure.ownedIssues : undefined;
  const body = new Container();
  const { fallbackStatus } = presentation;
  if (children.total > 0 || children.entries.length > 0 || fallbackStatus) {
    const calls = addCodeModeSection(body, "Calls", theme);
    calls.addChild({
      render: (width) =>
        renderCompactChildren(
          {
            ...children,
            entries: children.entries.map((child) => ({
              ...child,
              notices: [],
              issues: { coverage: "complete", entries: [] },
            })),
          },
          theme,
          width,
          animationFrame,
          presentation.timingEnabled,
          true,
          "flat",
        ),
      invalidate() {},
    });
    if (fallbackStatus) calls.addChild(new Text(fallbackStatus, 0, 0));
  }
  // Aggregate/evicted recovery belongs to the parent, not the last visible call.
  if (!presentation.contentOnly && allIssues) {
    body.addChild({
      render: (width) =>
        renderExpandedAttention(allIssues, claims, theme, width, children.total > 0),
      invalidate() {},
    });
  }
  if (!isPartial && raw.length > 0) {
    const formatted =
      !isError && !details.cancelled && !details.truncated && details.outputKind === "structured"
        ? formatStructuredCodeModeOutput(raw)
        : undefined;
    const label = formatted !== undefined ? "Result" : isError ? "Raw error" : "Raw output";
    const output = addCodeModeSection(body, label, theme);
    output.addChild(
      new Text(
        theme.fg(isError ? "error" : "toolOutput", formatted ?? codeModeOutputText(raw)),
        0,
        0,
      ),
    );
  }
  return body;
};
