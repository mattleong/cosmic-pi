import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { recordHeadingSubject } from "./heading-coverage";

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
  /** Whether the atom is part of a `·` fact after the first separator. */
  fact?: boolean;
  /** Whether the atom starts a name too wide for a row, split after its `-`, `_`, or `.`. */
  wideName?: boolean;
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
  for (const match of Fn.pipe(text, Str.matchAll(STYLING))) {
    const start = match.index ?? last;
    pushText(Fn.pipe(text, Str.slice(last, start)));
    result.push({ text: match[0], width: 0 });
    last = start + match[0].length;
  }
  pushText(Fn.pipe(text, Str.slice(last)));
  return result;
}

const isStyling = (item: Item) => item.width === 0 && Fn.pipe(item.text, Str.startsWith(ESC));

const visibleText = (atom: Atom) =>
  Arr.join(
    Arr.map(
      Arr.filter(atom.items, (item) => !isStyling(item)),
      (item) => item.text,
    ),
    "",
  );

const atomWidth = (atom: Atom) => Arr.reduce(atom.items, 0, (sum, item) => sum + item.width);

// A direction arrow travels with what it points at, so no row ends with one.
const ARROWS: ReadonlySet<string> = new Set(["→", "←"]);

/**
 * Splits a heading into atoms: words between spaces, and path parts after each `/` inside a word.
 * Each fact after a ` · ` separator is one atom led by the separator, and a lone `→` or `←` leads
 * the word after it, so no row ends with either.
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
    const shown = visibleText(atom);
    const separator = shown === "·";
    facts ||= separator;
    if (previous && atom.spaced && (open || (facts && !separator)))
      previous.items.push({ text: " ", width: 1 }, ...atom.items);
    else joined.push({ items: [...atom.items], spaced: atom.spaced, fact: facts });
    open = separator || ARROWS.has(shown);
  }
  return joined;
}

// Where a name too wide for a row may break, as `wrapFacts` breaks one.
const NAME_BREAKS: ReadonlySet<string> = new Set(["-", "_", "."]);

/**
 * A word too wide for a row split after each `-`, `_`, or `.` when every part then fits a row, as
 * `wrapFacts` breaks a long name; otherwise it stays whole and breaks mid-word where a row ends.
 * Such a name after a path's `/` starts a row, so the path breaks after its directory first.
 */
const nameParts = (atom: Atom, room: number): Atom[] => {
  if (atomWidth(atom) <= room) return [atom];
  const parts: Atom[] = [];
  let pending: Item[] = [];
  const finish = () => {
    parts.push({
      items: pending,
      spaced: parts.length === 0 && atom.spaced,
      fact: atom.fact === true,
      wideName: parts.length === 0,
    });
    pending = [];
  };
  for (const item of atom.items) {
    pending.push(item);
    if (NAME_BREAKS.has(item.text)) finish();
  }
  const last = parts.at(-1);
  if (Arr.some(pending, (item) => item.width > 0)) finish();
  else last?.items.push(...pending);
  return parts.length > 1 && Arr.every(parts, (part) => atomWidth(part) <= room) ? parts : [atom];
};

/**
 * A fact's width from its first atom through the path parts that follow it without a space, so a
 * fact that fits on a row moves to the next one whole rather than breaking after a `/`.
 */
const factWidth = (all: readonly Atom[], start: number): number => {
  let width = 0;
  for (const [index, atom] of all.entries()) {
    if (index < start) continue;
    if (index > start && atom.spaced) break;
    width += atomWidth(atom);
  }
  return width;
};

/**
 * A styled preview heading wrapped to `width`: between words, or after a `/` in a long path, with
 * continuation rows hanging two columns in. A `·` fact that fits on a row stays whole; a word wider
 * than a row breaks after `-`, `_`, or `.` when every part fits a row, else mid-word. The first row
 * keeps `firstRowReserve` columns clear, for the row's tag, even where that takes one more row, so
 * the tag never cuts the heading.
 */
export function wrapPreviewHeading(text: string, width: number, firstRowReserve = 0): string[] {
  if (width <= 0) return [];
  const reserve = Math.max(0, Math.min(firstRowReserve, width - HANG.length * 4));
  if (visibleWidth(text) <= width - reserve) return [text];
  return wrapRows(text, width, reserve);
}

function wrapRows(text: string, width: number, reserve: number): string[] {
  const hang = width > HANG.length * 4 ? HANG : "";
  const rows: Item[][] = [[]];
  let used = 0;
  const available = () => width - (rows.length > 1 ? hang.length : reserve);
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
  const all = Arr.flatMap(atoms(text), (atom) => nameParts(atom, width - hang.length));
  for (const [index, atom] of all.entries()) {
    const gap = atom.spaced && used > 0 ? 1 : 0;
    const size = atomWidth(atom);
    const whole = atom.fact === true && atom.spaced ? factWidth(all, index) : size;
    const moves = whole > size && whole <= width - hang.length && used + gap + whole > available();
    const afterSlash = atom.wideName === true && !atom.spaced;
    if (used > 0 && (moves || afterSlash || used + gap + size > available())) newRow();
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

/** Columns a collapsed row's first heading keeps clear on its first row, for the row's tag. */
export interface HeadingRoom {
  reserve: number;
}

// The room the next preview heading built keeps, while a collapsed preview body is built.
let pendingRoom: HeadingRoom | undefined;

/**
 * Builds a collapsed preview body whose first {@link previewHeadingText} keeps `room.reserve`
 * columns clear on its first row when it wraps, read each time it draws, so the shell's tag fits
 * beside it without cutting it.
 */
export function reservingHeadingRoom<I, A>(room: HeadingRoom, build: (input: I) => A, input: I): A {
  const previous = pendingRoom;
  pendingRoom = room;
  try {
    return build(input);
  } finally {
    pendingRoom = previous;
  }
}

/**
 * The room the collapsed preview body being built keeps for its tag, taken by the first heading
 * built, which alone carries the row's tag.
 */
export function takeHeadingRoom(): HeadingRoom | undefined {
  const room = pendingRoom;
  pendingRoom = undefined;
  return room;
}

/**
 * A component that draws a preview heading with {@link wrapPreviewHeading}. Given the row's renderer
 * `state`, a heading whose text holds the subject whole records each draw for `headingShowedSubject`,
 * so a body drawn after it in the same pass can leave out a field that only repeats the subject; a
 * row that ends in `…` records the subject incomplete.
 */
export function previewHeadingText(text: () => string, state?: WeakKey): Component {
  const room = takeHeadingRoom();
  let cached:
    | {
        readonly text: string;
        readonly width: number;
        readonly reserve: number;
        readonly rows: string[];
      }
    | undefined;
  return {
    render(width) {
      const current = text();
      const reserve = room?.reserve ?? 0;
      if (cached?.text !== current || cached.width !== width || cached.reserve !== reserve)
        cached = {
          text: current,
          width,
          reserve,
          rows: wrapPreviewHeading(current, width, reserve),
        };
      if (state !== undefined) recordHeadingSubject(state, true, cached.rows);
      return cached.rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
