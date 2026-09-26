/** Expanded presentation consumes only retained receipts and host timing snapshots. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  expandedSection,
  renderCompactChildren,
  renderCompactIssues,
  type CompactChild,
  type CompactIssue,
} from "pi-code-previews";
import { formatCodeModeProgram } from "./program-source.ts";
import { codeModeOutputText, formatStructuredCodeModeOutput } from "./result-output.ts";
import type { CodeModeRenderDetails } from "./tool-render-details.ts";

const lines = (render: (width: number) => string[]): Component => ({
  render,
  invalidate() {},
});

/** Program source as its own section; shared by the content-only call slot. */
export const renderProgramSection = (source: string | undefined, theme: Theme): Component =>
  expandedSection(
    theme,
    "Program",
    new Text(
      source === undefined
        ? theme.fg("dim", "(program not available)")
        : formatCodeModeProgram(source)
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n"),
      0,
      0,
    ),
  );

/**
 * Fixed order: the run's issues, Program, Calls with each call's issues beneath it, then the
 * labeled output or error. Content-only slots omit what the shell already shows.
 */
export const renderExpandedCodeModeResult = (input: {
  readonly details: CodeModeRenderDetails;
  readonly rows: readonly CompactChild[];
  readonly issues: readonly CompactIssue[];
  readonly raw: string;
  readonly isPartial: boolean;
  readonly isError: boolean;
  readonly theme: Theme;
  readonly animationFrame: number;
  readonly timingEnabled: boolean;
  /** The shell already renders the heading, issues and program. */
  readonly contentOnly: boolean;
  readonly program: string | undefined;
}): Component => {
  const { details, theme, raw, isPartial, isError } = input;
  const sections: Component[] = [];
  if (!input.contentOnly) {
    sections.push(lines((width) => renderCompactIssues(input.issues, theme, width, true, "")));
    sections.push(renderProgramSection(input.program, theme));
  }
  if (details.counts.total > 0 || input.rows.length > 0)
    sections.push(
      expandedSection(
        theme,
        "Calls",
        lines((width) =>
          renderCompactChildren(
            { total: details.counts.total, entries: input.rows },
            theme,
            width,
            {
              animationFrame: input.animationFrame,
              timingEnabled: input.timingEnabled,
              layout: "flat",
              all: true,
            },
          ),
        ),
      ),
    );
  // Trailing blank lines carry no information and would pad the frame.
  const output = raw.replace(/\s+$/u, "");
  if (!isPartial && output.length > 0) {
    const structured =
      !isError && !details.cancelled && !details.truncated && details.outputKind === "structured"
        ? formatStructuredCodeModeOutput(output)
        : undefined;
    sections.push(
      expandedSection(
        theme,
        isError ? "Error" : structured !== undefined ? "Result" : "Output",
        new Text(
          theme.fg(isError ? "error" : "toolOutput", structured ?? codeModeOutputText(output)),
          0,
          0,
        ),
      ),
    );
  }
  return {
    render: (width) => sections.flatMap((section) => section.render(width)),
    invalidate: () => {
      for (const section of sections) section.invalidate();
    },
  };
};
