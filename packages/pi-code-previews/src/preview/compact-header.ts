import { visibleWidth } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Work is bounded by input length, not the requested terminal width. */
export function middleElide(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  const parts = Array.from(graphemes.segment(text), ({ segment }) => ({
    text: segment,
    width: visibleWidth(segment),
  }));
  let remaining = width - 1;
  let left = 0;
  let right = parts.length;
  let head = "";
  let tail = "";
  // Prefer the shorter retained side, but never split a terminal grapheme.
  let headWidth = 0;
  let tailWidth = 0;
  while (left < right) {
    const fromLeft = headWidth <= tailWidth;
    const part = parts[fromLeft ? left : right - 1]!;
    if (part.width > remaining) break;
    remaining -= part.width;
    if (fromLeft) {
      head += part.text;
      headWidth += part.width;
      left++;
    } else {
      tail = part.text + tail;
      tailWidth += part.width;
      right--;
    }
  }
  return `${head}…${tail}`;
}

export function allocateCompactHeader(
  identity: string,
  subject: string,
  counters: readonly string[],
  optional: readonly (string | undefined)[],
  width: number,
  separator = " · ",
  timing?: string,
): string {
  return layoutCompactHeader(identity, subject, counters, optional, width, separator, timing).row;
}

/**
 * Counters are alternatives in priority order: the first that fits owns the routine-detail
 * slot, so a producer can offer a shorter fallback for narrow rows. `counter` reports which
 * one was shown.
 */
export function layoutCompactHeader(
  identity: string,
  subject: string,
  counters: readonly string[],
  optional: readonly (string | undefined)[],
  width: number,
  separator = " · ",
  timing?: string,
) {
  // Select semantically before measuring: narrow rows must not substitute lower-priority detail.
  counters = counters.filter((value) => value.trim());
  optional = counters.length ? [] : optional.filter((value) => value?.trim()).slice(0, 1);
  const remaining = width - visibleWidth(identity);
  if (remaining <= 0) return { row: clipToWidth(identity, width, ""), counter: undefined };
  const subjectWidth = visibleWidth(subject);
  const subjectMinimum = subject ? 1 + Math.min(12, subjectWidth) : 0;
  // Counters carry progress/outcome facts. Spend available subject space on them
  // before eliding the target, rather than dropping a counter at half the row.
  const counterBudget = remaining - subjectMinimum;
  const counter = counters.find((value) => visibleWidth(`${separator}${value}`) <= counterBudget);
  const counterText = counter === undefined ? "" : `${separator}${counter}`;
  const counterWidth = visibleWidth(counterText);
  // Explicit timing is secondary to counts and must not replace a counter that cannot fit.
  const timingToken = timing?.trim() ? `${separator}${timing}` : "";
  const timingText =
    (!counters.length || counterText.length > 0) &&
    counterWidth + visibleWidth(timingToken) <= counterBudget
      ? timingToken
      : "";
  const target = middleElide(subject, remaining - counterWidth - visibleWidth(timingText) - 1);
  let row = identity + (target ? ` ${target}` : "") + counterText;
  if (target !== subject) return { row: row + timingText, counter };
  let used = visibleWidth(row) + visibleWidth(timingText);
  for (const value of optional) {
    if (!value) continue;
    const token = `${separator}${value}`;
    const tokenWidth = visibleWidth(token);
    if (used + tokenWidth > width) continue;
    row += token;
    used += tokenWidth;
  }
  return { row: row + timingText, counter };
}
