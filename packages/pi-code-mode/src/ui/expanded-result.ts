/** Expanded presentation consumes only retained receipts and host timing snapshots. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
  renderCompactChildren,
  renderCompactIssues,
  summaryCompactIssues,
  withoutFailureBodyIssues,
  renderCompactRow,
  type CompactSummary,
} from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import { truncateDisplay } from "../tools/format.ts";
import type { CodeModeCallEntry } from "../tools/format.ts";
import { codeModeCallRows } from "./call-rows.ts";
import { formatCodeModeProgram } from "./program-source.ts";
import { codeModeOutputText, formatStructuredCodeModeOutput } from "./result-output.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";
import { addCodeModeSection } from "./sections.ts";

export interface ExpandedPresentation {
  readonly readRequest?: { readonly id: string };
  readonly source?: string | undefined;
  readonly summary?: CompactSummary | undefined;
  readonly ownsCall?: boolean;
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
    total: details.totalToolCalls,
    entries: codeModeCallRows(details, phase, presentation.liveElapsed),
  };
  const summary = presentation.summary;
  const allIssues = summary ? summaryCompactIssues(summary, true) : undefined;
  // Only this exact outer body can own its copied root/continuation issues.
  // Nested result ownership is unrelated and must not erase independent recovery.
  const issues =
    allIssues && !isPartial && raw === summary?.failure?.details
      ? withoutFailureBodyIssues(allIssues, summary.failure.ownedIssues)
      : allIssues;
  const body = new Container();
  if (presentation.ownsCall) {
    if (summary)
      body.addChild({
        render: (width) => [
          renderCompactRow(
            {
              name: "Code Mode",
              phase,
              summary,
              animationFrame,
              timingEnabled: presentation.timingEnabled !== false,
            },
            theme,
            width,
          ),
        ],
        invalidate() {},
      });
    else body.addChild(new Text("Code Mode", 0, 0));
    const program = addCodeModeSection(body, "Program", theme);
    program.addChild(
      new Text(
        truncateDisplay(
          stripTerminalControls(
            formatCodeModeProgram(presentation.source ?? "(program not available)"),
          ),
          CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.maximum,
        ),
        0,
        0,
      ),
    );
  }
  const fallbackStatus = !presentation.ownsCall ? presentation.fallbackStatus : undefined;
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
  if (issues?.entries.length) {
    const attention = addCodeModeSection(body, "Notices", theme);
    attention.addChild({
      render: (width) => renderCompactIssues(issues, theme, width, true, true),
      invalidate() {},
    });
  }
  if (!isPartial && raw.length > 0) {
    const formatted =
      !isError && !details.cancelled && !details.truncated && details.outputKind === "structured"
        ? formatStructuredCodeModeOutput(raw)
        : undefined;
    const output = addCodeModeSection(body, isError ? "Error" : "Result", theme);
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
