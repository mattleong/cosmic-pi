/** Expanded presentation consumes only retained receipts and host timing snapshots. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection, renderCompactChildren, type CompactChild } from "pi-code-previews";
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
 * The program's output or diagnostic, and the recovery notes Code Mode appended for the agent.
 * An offset that does not land on the notes separator leaves the whole text as output.
 */
const splitAgentNotes = (raw: string, offset: number | undefined) => {
  const valid = offset !== undefined && offset > 0 && raw.startsWith("\n\n", offset);
  return {
    output: (valid ? raw.slice(0, offset) : raw).replace(/\s+$/u, ""),
    notes: valid ? raw.slice(offset).trim() : "",
  };
};

/**
 * Fixed order after the shell's heading and issues: Program, Calls with each call's issues
 * beneath it, the labeled output or error, then agent notes. Content-only slots omit the
 * program, which the shell's content call slot already shows.
 */
export const renderExpandedCodeModeResult = (input: {
  readonly details: CodeModeRenderDetails;
  readonly rows: readonly CompactChild[];
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
  if (!input.contentOnly) sections.push(renderProgramSection(input.program, theme));
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
  const { output, notes } = splitAgentNotes(raw, details.notesOffset);
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
  if (!isPartial && notes.length > 0)
    sections.push(
      expandedSection(
        theme,
        "Agent notes",
        new Text(theme.fg("dim", codeModeOutputText(notes)), 0, 0),
      ),
    );
  return {
    render: (width) => sections.flatMap((section) => section.render(width)),
    invalidate: () => {
      for (const section of sections) section.invalidate();
    },
  };
};
