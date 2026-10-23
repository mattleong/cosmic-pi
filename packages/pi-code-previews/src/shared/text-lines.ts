import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { indexOfFrom } from "pi-cosmic-core";

// Bound once: Pi's loader routes each imported-helper call through an interop proxy.
const indexFrom = indexOfFrom;

export function forEachRawTextLine(text: string, callback: (line: string) => false | void): void {
  let start = 0;
  while (start <= text.length) {
    const newline = indexFrom(text, "\n", start);
    if (newline < 0) {
      callback(Fn.pipe(text, Str.slice(start)));
      break;
    }
    if (callback(Fn.pipe(text, Str.slice(start, newline))) === false) break;
    start = newline + 1;
  }
}

export function splitLinesLimited(text: string, limit: number): string[] {
  const max = Math.max(0, Math.floor(limit));
  if (Number.isNaN(max) || max <= 0) return [];
  const lines: string[] = [];
  forEachRawTextLine(text, (line) => {
    lines.push(line);
    if (lines.length >= max) return false;
    return undefined;
  });
  return lines;
}
