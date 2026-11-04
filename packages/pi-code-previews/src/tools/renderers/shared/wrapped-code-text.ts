import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { wrapAnsiToWidth } from "../../../shared/terminal-text";

/** One logical preview line and the prefix its wrapped continuation rows start with. */
export interface WrappedCodeRow {
  readonly text: string;
  readonly continuation: string;
}

/** Code continues past its own indentation by this much, so a wrapped tail never reads as a new line. */
const HANGING_INDENT = 2;

/** The continuation for an unnumbered code line: its own indentation plus a hanging indent. */
export function hangingContinuation(line: string): string {
  const indentation = line.length - Str.trimStart(line).length;
  return Fn.pipe(" ", Str.repeat(indentation + HANGING_INDENT));
}

/**
 * Wraps code at the width it is drawn at, so a long line continues under its own code column
 * instead of running back through the line-number gutter or the indentation.
 */
export class WrappedCodeText implements Component {
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;
  private readonly rows: ReadonlyArray<WrappedCodeRow>;

  constructor(rows: ReadonlyArray<WrappedCodeRow>) {
    this.rows = rows;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRows) return this.cachedRows;
    const rows = Arr.flatMap(this.rows, ({ text, continuation }) =>
      wrapAnsiToWidth(
        text,
        width,
        Number.POSITIVE_INFINITY,
        // A prefix wider than half the row would leave almost no room for the code it carries.
        visibleWidth(continuation) * 2 <= width ? continuation : "",
        { breakAtWords: true },
      ),
    );
    this.cachedWidth = width;
    this.cachedRows = rows;
    return rows;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }
}
