import type { BackgroundLogSlice, BackgroundLogStream } from "./model.ts";
import { plainTerminalText } from "./terminal-text.ts";

/** Matches literal text in the plain output readers see, per stream and never across a gap. */
export class OutputMatcher {
  private readonly carry = { stdout: "", stderr: "" } satisfies Record<BackgroundLogStream, string>;
  private readonly contains: string | undefined;
  private scannedCursor: number;

  constructor(contains: string | undefined, afterCursor: number) {
    this.contains = contains;
    this.scannedCursor = afterCursor;
  }

  get afterCursor(): number {
    return this.scannedCursor;
  }

  match(slice: BackgroundLogSlice): number | undefined {
    const contains = this.contains;
    if (!contains) return undefined;
    if (slice.earliestAvailableCursor > this.scannedCursor) this.reset();
    let matchCursor: number | undefined;
    for (const event of slice.events) {
      if (event.droppedBefore) this.reset();
      const candidate = this.carry[event.stream] + plainTerminalText(event.text);
      if (candidate.includes(contains)) {
        matchCursor = event.cursor;
        break;
      }
      this.carry[event.stream] = contains.length > 1 ? candidate.slice(-(contains.length - 1)) : "";
    }
    this.scannedCursor = Math.max(this.scannedCursor, slice.nextCursor);
    return matchCursor;
  }

  private reset(): void {
    this.carry.stdout = "";
    this.carry.stderr = "";
  }
}
