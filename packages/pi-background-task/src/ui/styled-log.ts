import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalStyledFragments } from "pi-cosmic-core";
import type { BackgroundLogEvent, BackgroundLogStream } from "../task/model.ts";

const MAX_CACHED_TASKS = 4;
const STREAMS = ["stdout", "stderr"] as const satisfies ReadonlyArray<BackgroundLogStream>;

const closeVisualStyle = (line: string): string =>
  Fn.pipe(line, Str.includes("\u001b[")) && !Fn.pipe(line, Str.endsWith("\u001b[0m"))
    ? `${line}\u001b[0m`
    : line;

interface StyledLine {
  readonly stream: BackgroundLogStream;
  readonly text: string;
  /** The newest event contributing to the line; the line leaves once that event is evicted. */
  readonly lastCursor: number;
}

interface Fragment {
  readonly channel: BackgroundLogStream;
  readonly text: string;
  readonly cursor: number;
}

// Splits on newlines so each fragment's reopened style is the style at its line start.
const lineFragments = (event: BackgroundLogEvent): Fragment[] =>
  Arr.map(Str.split(event.text, /(?<=\n)/u), (text) => ({
    channel: event.stream,
    text,
    cursor: event.cursor,
  }));

/** One task's styled log lines and wrapped rows, extended as new events arrive. */
class TaskLogRows {
  private renderedCursor = 0;
  private styles: Record<BackgroundLogStream, string> = { stdout: "", stderr: "" };
  private readonly lines: StyledLine[] = [];
  private open: StyledLine | undefined;
  private width = 0;
  private readonly rowCounts: number[] = [];
  private readonly wrappedRows: string[] = [];
  private result:
    | {
        readonly events: ReadonlyArray<BackgroundLogEvent>;
        readonly rows: ReadonlyArray<string>;
      }
    | undefined;
  private readonly gutter: Readonly<Record<BackgroundLogStream, string>>;

  constructor(gutter: Readonly<Record<BackgroundLogStream, string>>) {
    this.gutter = gutter;
  }

  rows(events: ReadonlyArray<BackgroundLogEvent>, width: number): ReadonlyArray<string> {
    if (this.result?.events === events && this.width === width) return this.result.rows;
    this.evictBefore(events[0]?.cursor ?? Number.POSITIVE_INFINITY);
    this.extend(Arr.filter(events, (event) => event.cursor > this.renderedCursor));
    if (this.width !== width) {
      this.width = width;
      this.rowCounts.length = 0;
      this.wrappedRows.length = 0;
      for (const line of this.lines) this.pushWrapped(line);
    }
    const rows = this.open ? [...this.wrappedRows, ...this.wrap(this.open)] : this.wrappedRows;
    this.result = { events, rows: rows === this.wrappedRows ? [...rows] : rows };
    return this.result.rows;
  }

  private evictBefore(cursor: number): void {
    if (this.open && this.open.lastCursor < cursor) this.open = undefined;
    let count = 0;
    while (count < this.lines.length && (this.lines[count]?.lastCursor ?? 0) < cursor) count += 1;
    if (count === 0) return;
    this.lines.splice(0, count);
    const rows = Arr.reduce(this.rowCounts.splice(0, count), 0, (sum, rowCount) => sum + rowCount);
    this.wrappedRows.splice(0, rows);
  }

  private extend(events: ReadonlyArray<BackgroundLogEvent>): void {
    const last = events.at(-1);
    if (!last) return;
    this.renderedCursor = last.cursor;
    // Restore each stream's style, render the new lines, then read back the styles they leave.
    const restore = Arr.map(STREAMS, (channel) => ({
      channel,
      text: this.styles[channel],
      cursor: 0,
    }));
    const fresh = Arr.flatMap(events, lineFragments);
    const probes = Arr.map(STREAMS, (channel) => ({ channel, text: "", cursor: 0 }));
    const rendered = sanitizeTerminalStyledFragments([...restore, ...fresh, ...probes]);
    for (const [index, channel] of STREAMS.entries())
      this.styles[channel] = rendered[restore.length + fresh.length + index]?.reopenSgr ?? "";
    for (const [index, fragment] of fresh.entries()) {
      const output = rendered[restore.length + index];
      if (output) this.append(fragment, output.text, output.reopenSgr);
    }
  }

  private append(fragment: Fragment, text: string, reopenSgr: string): void {
    // A stream switch ends the open line, so streams never share one.
    if (this.open && this.open.stream !== fragment.channel) this.complete();
    const ended = Fn.pipe(text, Str.endsWith("\n"));
    const body = ended ? Fn.pipe(text, Str.slice(0, -1)) : text;
    this.open = {
      stream: fragment.channel,
      text: this.open ? `${this.open.text}${body}` : `${reopenSgr}${body}`,
      lastCursor: fragment.cursor,
    };
    if (ended) this.complete();
  }

  private complete(): void {
    const line = this.open;
    this.open = undefined;
    if (!line || visibleWidth(line.text) === 0) return;
    this.lines.push(line);
    if (this.width > 0) this.pushWrapped(line);
  }

  private pushWrapped(line: StyledLine): void {
    const rows = this.wrap(line);
    this.rowCounts.push(rows.length);
    for (const row of rows) this.wrappedRows.push(row);
  }

  private wrap(line: StyledLine): string[] {
    const gutter = this.gutter[line.stream];
    const contentWidth = Math.max(1, this.width - visibleWidth(gutter));
    return Arr.map(
      wrapTextWithAnsi(closeVisualStyle(line.text), contentWidth),
      (row) => `${gutter}${closeVisualStyle(row)}`,
    );
  }
}

/**
 * Styled, wrapped log rows for the task manager. Each task's rows are kept between renders, so
 * an update parses only new events and a repaint at the same width does no wrapping.
 */
export class StyledLogRows {
  private readonly tasks = new Map<string, TaskLogRows>();
  private readonly gutter: Readonly<Record<BackgroundLogStream, string>>;

  constructor(gutter: Readonly<Record<BackgroundLogStream, string>>) {
    this.gutter = gutter;
  }

  rows(
    task: string,
    events: ReadonlyArray<BackgroundLogEvent>,
    width: number,
  ): ReadonlyArray<string> {
    let rows = this.tasks.get(task);
    if (rows) this.tasks.delete(task);
    else rows = new TaskLogRows(this.gutter);
    this.tasks.set(task, rows);
    for (const stale of this.tasks.keys()) {
      if (this.tasks.size <= MAX_CACHED_TASKS) break;
      this.tasks.delete(stale);
    }
    return rows.rows(events, width);
  }
}
