import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { codePreviewPerformanceConfig } from "../config/env";
import { wrapAnsiToWidth } from "../shared/terminal-text";
import { createDiffBackgroundResolver, diffLineBg } from "./background";
import { DIFF_ADD_MARKER, DIFF_REMOVE_MARKER } from "./parse";

type MarkedDiffLine = { kind?: "add" | "remove"; line: string };

export class FullWidthDiffText implements Component {
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;
  private text: string;
  private readonly theme: Theme | undefined;

  constructor(text: string, theme?: Theme) {
    this.text = text;
    this.theme = theme;
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRows) return this.cachedRows;
    const diffBackground = createDiffBackgroundResolver(this.theme);
    const rows: string[] = [];
    for (const rawLine of this.text.split("\n")) {
      const { kind, line } = parseMarkedDiffLine(rawLine);
      const continuation = continuationPrefix(line);
      const wrappedRows = wrapAnsiToWidth(
        line,
        width,
        codePreviewPerformanceConfig.diffWrapRows,
        visibleWidth(continuation) < width ? continuation : "",
      );
      if (!kind) {
        rows.push(...wrappedRows);
        continue;
      }
      for (const row of wrappedRows) {
        const padding = " ".repeat(Math.max(0, width - visibleWidth(row)));
        rows.push(diffLineBg(kind, row + padding, diffBackground));
      }
    }
    this.cachedWidth = width;
    this.cachedRows = rows;
    return rows;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }
}

function parseMarkedDiffLine(rawLine: string): MarkedDiffLine {
  if (rawLine.startsWith(DIFF_ADD_MARKER))
    return { kind: "add", line: rawLine.slice(DIFF_ADD_MARKER.length) };
  if (rawLine.startsWith(DIFF_REMOVE_MARKER))
    return { kind: "remove", line: rawLine.slice(DIFF_REMOVE_MARKER.length) };
  return { line: rawLine };
}

function continuationPrefix(line: string): string {
  const pipe = line.indexOf("│ ");
  if (pipe < 0) return "";
  return " ".repeat(visibleWidth(line.slice(0, pipe + 2)));
}
