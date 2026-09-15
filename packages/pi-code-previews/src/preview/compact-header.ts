import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
): string {
  // Select semantically before measuring: narrow rows must not substitute lower-priority detail.
  counters = counters.filter((value) => value.trim()).slice(0, 1);
  optional = counters.length ? [] : optional.filter((value) => value?.trim()).slice(0, 1);
  const remaining = width - visibleWidth(identity);
  if (remaining <= 0) return truncateToWidth(identity, width, "");
  const subjectWidth = visibleWidth(subject);
  const subjectMinimum = subject ? 1 + Math.min(12, subjectWidth) : 0;
  const fullSubjectSpace = subject ? 1 + subjectWidth : 0;
  const counterBudget = Math.min(
    remaining - subjectMinimum,
    Math.max(Math.floor(remaining / 2), remaining - fullSubjectSpace),
  );
  let counterText = "";
  let counterWidth = 0;
  for (const counter of counters) {
    const token = ` · ${counter}`;
    const tokenWidth = visibleWidth(token);
    if (counterWidth + tokenWidth > counterBudget) continue;
    counterText += token;
    counterWidth += tokenWidth;
  }
  const target = middleElide(subject, remaining - counterWidth - 1);
  let row = identity + (target ? ` ${target}` : "") + counterText;
  if (target !== subject) return row;
  let used = visibleWidth(row);
  for (const value of optional) {
    if (!value) continue;
    const token = ` · ${value}`;
    const tokenWidth = visibleWidth(token);
    if (used + tokenWidth > width) continue;
    row += token;
    used += tokenWidth;
  }
  return row;
}
