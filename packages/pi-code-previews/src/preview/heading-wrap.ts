import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const HANG = "  ";

interface Item {
  readonly text: string;
  readonly width: number;
}

/** A run that never breaks inside, and whether a space or nothing separates it from the last. */
interface Atom {
  readonly items: Item[];
  spaced: boolean;
}

// Styling sequences, `ESC [ … m`, which take no width.
const STYLING = new RegExp(`${ESC}\\[[0-9;:]*m`, "gu");

/** Styled text as styling sequences and graphemes. */
function items(text: string): Item[] {
  const result: Item[] = [];
  const pushText = (part: string) => {
    for (const { segment } of graphemes.segment(part))
      result.push({ text: segment, width: visibleWidth(segment) });
  };
  let last = 0;
  for (const match of Str.matchAll(STYLING)(text)) {
    const start = match.index ?? last;
    pushText(Str.slice(last, start)(text));
    result.push({ text: match[0], width: 0 });
    last = start + match[0].length;
  }
  pushText(Str.slice(last)(text));
  return result;
}

const isStyling = (item: Item) => item.width === 0 && Str.startsWith(ESC)(item.text);

const visibleText = (atom: Atom) =>
  Arr.join(
    Arr.map(
      Arr.filter(atom.items, (item) => !isStyling(item)),
      (item) => item.text,
    ),
    "",
  );

const atomWidth = (atom: Atom) => Arr.reduce(atom.items, 0, (sum, item) => sum + item.width);

/**
 * Splits a heading into atoms: words between spaces, and path parts after each `/` inside a word.
 * Each fact after a ` · ` separator is one atom led by the separator, so no row ends with one.
 */
function atoms(text: string): Atom[] {
  const result: Atom[] = [];
  let current: Atom = { items: [], spaced: false };
  const finish = (next: boolean) => {
    if (Arr.some(current.items, (item) => item.width > 0)) {
      result.push(current);
      current = { items: [], spaced: next };
    } else current.spaced ||= next;
  };
  const all = items(text);
  for (const [index, item] of all.entries()) {
    if (item.text === " ") {
      finish(true);
      continue;
    }
    current.items.push(item);
    const next = all[index + 1];
    if (item.text === "/" && next !== undefined && next.text !== " ") finish(false);
  }
  finish(false);
  const joined: Atom[] = [];
  // Facts after the first ` · ` stay whole, each led by its separator.
  let facts = false;
  let open = false;
  for (const atom of result) {
    const previous = joined.at(-1);
    const separator = visibleText(atom) === "·";
    facts ||= separator;
    if (previous && atom.spaced && (open || (facts && !separator)))
      previous.items.push({ text: " ", width: 1 }, ...atom.items);
    else joined.push({ items: [...atom.items], spaced: atom.spaced });
    open = separator;
  }
  return joined;
}

/**
 * A styled preview heading wrapped to `width`: between words, or after a `/` in a long path, with
 * continuation rows hanging two columns in. A word wider than a row breaks mid-word.
 */
export function wrapPreviewHeading(text: string, width: number): string[] {
  if (width <= 0) return [];
  if (visibleWidth(text) <= width) return [text];
  const hang = width > HANG.length * 4 ? HANG : "";
  const rows: Item[][] = [[]];
  let used = 0;
  const available = () => width - (rows.length > 1 ? hang.length : 0);
  const newRow = () => {
    rows.push([]);
    used = 0;
  };
  const place = (item: Item) => {
    const row = rows.at(-1);
    if (!row) return;
    if (item.width > 0 && used > 0 && used + item.width > available()) {
      newRow();
      return place(item);
    }
    row.push(item);
    used += item.width;
  };
  for (const atom of atoms(text)) {
    const gap = atom.spaced && used > 0 ? 1 : 0;
    const size = atomWidth(atom);
    if (used > 0 && used + gap + size > available()) newRow();
    else if (gap) place({ text: " ", width: 1 });
    for (const item of atom.items) place(item);
  }
  // Each row restates the styling before it, so a continuation keeps its color.
  const styled: string[] = [];
  let carried = "";
  return Arr.map(rows, (row, index) => {
    const body = Arr.join(
      Arr.map(row, (item) => item.text),
      "",
    );
    const line = `${index === 0 ? "" : hang}${carried}${body}${RESET}`;
    for (const item of row)
      if (isStyling(item)) {
        if (item.text === RESET || item.text === `${ESC}[m`) styled.length = 0;
        else styled.push(item.text);
      }
    carried = Arr.join(styled, "");
    return line;
  });
}

/** A component that draws a preview heading with {@link wrapPreviewHeading}. */
export function previewHeadingText(text: () => string): Component {
  let cached:
    | { readonly text: string; readonly width: number; readonly rows: string[] }
    | undefined;
  return {
    render(width) {
      const current = text();
      if (cached?.text !== current || cached.width !== width)
        cached = { text: current, width, rows: wrapPreviewHeading(current, width) };
      return cached.rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
