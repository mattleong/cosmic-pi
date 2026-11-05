import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { lastIndexOfFrom } from "pi-cosmic-core/text-scan";

const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const STARTING_SPINNER_FRAMES = ["◌", "◔", "◑", "◕"] as const;

/** Every frame of the running spinner, by which a reader recognizes a running row's glyph. */
export const RUNNING_SPINNER_FRAMES: ReadonlyArray<string> = BRAILLE_SPINNER_FRAMES;

const frameAt = (frames: ReadonlyArray<string>, frame: number, fallback: string): string =>
  frames[Math.abs(Math.floor(frame)) % frames.length] ?? fallback;

export const SPINNER_FRAME_MS = 160;

export const spinnerFrameAt = (now: number): number => Math.floor(now / SPINNER_FRAME_MS);

export const startingSpinnerFrame = (frame: number): string =>
  frameAt(STARTING_SPINNER_FRAMES, frame, "◌");

/** The suite separator between inline facts and key-hint pairs; never `•`, `|`, or `│`. */
export const INLINE_SEPARATOR = " · ";

/** Joins inline facts with the suite separator, skipping empty or disabled parts. */
export const joinInline = (parts: ReadonlyArray<string | false | null | undefined>): string =>
  Arr.join(
    Arr.filter(parts, (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part)),
    INLINE_SEPARATOR,
  );

/**
 * Suite-wide status glyphs; each has exactly one meaning (docs/architecture/ui-conventions.md).
 * Live running work uses the spinner from `managerActivityGlyph`; `neutral` marks a state with no
 * verdict, such as work still running in a saved snapshot, where a spinner would freeze.
 */
export const SUITE_STATUS_GLYPHS = {
  succeeded: "✓",
  failed: "✗",
  warning: "⚠",
  stopped: "⊘",
  stopping: "◒",
  uncertain: "≈",
  paused: "‖",
  queued: "○",
  waiting: "?",
  info: "ℹ",
  neutral: "•",
} as const;

export type ManagerLayoutTier = "narrow" | "stacked" | "wide";

export const managerLayoutTier = (width: number): ManagerLayoutTier =>
  width >= 100 ? "wide" : width >= 60 ? "stacked" : "narrow";

/** `attention` marks work waiting on a person's or agent's reply or decision; it is not a problem. */
export type ManagerNoticeKind = "info" | "success" | "warning" | "error" | "attention";

const MANAGER_NOTICE_GLYPHS = {
  info: "ℹ",
  success: "✓",
  warning: "⚠",
  error: "✗",
  attention: "?",
} satisfies Readonly<Record<ManagerNoticeKind, string>>;

export const managerNoticeGlyph = (kind: ManagerNoticeKind): string => MANAGER_NOTICE_GLYPHS[kind];

const MANAGER_NOTICE_COLORS = {
  info: "muted",
  success: "success",
  warning: "warning",
  error: "error",
  attention: "accent",
} as const satisfies Readonly<Record<ManagerNoticeKind, string>>;

export const managerNoticeColor = (kind: ManagerNoticeKind) => MANAGER_NOTICE_COLORS[kind];

type ManagerStateGlyphKind = "paused" | "done" | "failed" | "stopped" | "stopping";
export type ManagerActivityKind = "pending" | "running" | "waiting" | ManagerStateGlyphKind;
export type ManagerStatusColor = "accent" | "success" | "warning" | "error" | "muted" | "dim";

const MANAGER_STATE_GLYPHS = {
  paused: "‖",
  done: "✓",
  failed: "✗",
  stopped: "⊘",
  stopping: "◒",
} satisfies Readonly<Record<ManagerStateGlyphKind, string>>;

export const managerStateGlyph = (kind: ManagerStateGlyphKind): string =>
  MANAGER_STATE_GLYPHS[kind];

export const managerActivityGlyph = (kind: ManagerActivityKind, frame = 0): string =>
  Match.value(kind).pipe(
    Match.when("pending", () => startingSpinnerFrame(frame)),
    Match.when("running", () => frameAt(BRAILLE_SPINNER_FRAMES, frame, "⠋")),
    Match.when("waiting", () => managerNoticeGlyph("attention")),
    Match.orElse(managerStateGlyph),
  );

export const managerActivityColor = (kind: ManagerActivityKind): ManagerStatusColor => {
  if (kind === "pending" || kind === "running") return "accent";
  if (kind === "waiting") return managerNoticeColor("attention");
  if (kind === "done") return "success";
  if (kind === "failed") return "error";
  if (kind === "stopped" || kind === "paused") return "muted";
  return "warning";
};

const MANAGER_ACTIVITY_LABELS = {
  pending: "starting",
  running: "running",
  waiting: "waiting",
  paused: "paused",
  stopping: "stopping",
  done: "finished",
  failed: "failed",
  stopped: "stopped",
} satisfies Readonly<Record<ManagerActivityKind, string>>;

export const managerActivityLabel = (kind: ManagerActivityKind): string =>
  MANAGER_ACTIVITY_LABELS[kind];

const STYLE_RESET = "\u001b[0m";

// A separator left stranded before a cut goes with it: `read-only…`, not `read-only ·…`.
const STRANDED_SEPARATORS = [" ·", " →"] as const;

// A cut at a word boundary leaves no space before the ellipsis: `Approve…`, not `Approve …`.
const closeUpMarker = (clipped: string, marker: string): string => {
  const at = lastIndexOfFrom(clipped, marker, clipped.length);
  if (at <= 0) return clipped;
  let head = Fn.pipe(clipped, Str.slice(0, at));
  let reset = false;
  let trimmed = false;
  for (;;) {
    if (Fn.pipe(head, Str.endsWith(STYLE_RESET))) {
      head = Fn.pipe(head, Str.slice(0, head.length - STYLE_RESET.length));
      reset = true;
    } else if (Fn.pipe(head, Str.endsWith(" "))) {
      head = Fn.pipe(head, Str.slice(0, -1));
      trimmed = true;
    } else if (
      Arr.some(STRANDED_SEPARATORS, (separator) => Fn.pipe(head, Str.endsWith(separator)))
    ) {
      head = Fn.pipe(head, Str.slice(0, -2));
      trimmed = true;
    } else break;
  }
  if (!trimmed || head.length === 0) return clipped;
  return `${head}${reset ? STYLE_RESET : ""}${Fn.pipe(clipped, Str.slice(at))}`;
};

const FACT_ARROW = " → ";

// A name too wide for a row splits after `-`, `_`, or `.` only when every part then fits a row;
// otherwise it stays one run, so a blob such as JSON never strands a fragment like `file.`.
const nameTokens = (segment: string, restWidth: number) => {
  if (visibleWidth(segment) <= restWidth) return [{ token: segment, startsWideName: false }];
  const parts = Str.split(segment, /(?<=[-_.])/u);
  return Arr.every(parts, (part) => visibleWidth(part) <= restWidth)
    ? Arr.map(parts, (token, index) => ({ token, startsWideName: index === 0 }))
    : [{ token: segment, startsWideName: false }];
};

// Splits one word too wide for a row after its `/` separators, then after `-`, `_`, or `.`, then
// anywhere, so a long path breaks between directories and names. The first row takes what fits
// in `firstWidth` and may be empty. A name too wide for any row whose parts each fit one starts a
// row after its `/`, so a path breaks after its directory before it breaks inside the name; a run
// with no such parts fills each row it reaches.
const breakWideWord = (word: string, firstWidth: number, restWidth: number): string[] => {
  const tokens = Arr.flatMap(Str.split(word, /(?<=\/)/u), (segment) =>
    nameTokens(segment, restWidth),
  );
  const rows: string[] = [];
  let current = "";
  const limit = () => (rows.length === 0 ? firstWidth : restWidth);
  for (const { token, startsWideName } of tokens) {
    if (startsWideName && Fn.pipe(current, Str.endsWith("/"))) {
      rows.push(current);
      current = "";
    }
    const tokenWidth = visibleWidth(token);
    if (visibleWidth(current) + tokenWidth <= limit()) {
      current = `${current}${token}`;
      continue;
    }
    if (tokenWidth <= restWidth) {
      if (current || rows.length === 0) rows.push(current);
      current = token;
      continue;
    }
    const space = Math.max(0, limit() - visibleWidth(current));
    const head = space > 0 ? sliceByColumn(token, 0, space, true) : "";
    if (current || head || rows.length === 0) rows.push(`${current}${head}`);
    const chunks = wrapTextWithAnsi(
      sliceByColumn(token, visibleWidth(head), tokenWidth - visibleWidth(head)),
      restWidth,
    );
    rows.push(...chunks.slice(0, -1));
    current = Option.getOrElse(Arr.last(chunks), () => "");
  }
  if (current) rows.push(current);
  return rows;
};

// A wide word continues on a part-filled row only when the part that fits there is worth reading
// (8 columns, or a quarter of a narrow row); a smaller head would strand `~/` at the row's end.
const meaningfulHead = (restWidth: number): number => Math.min(8, Math.ceil(restWidth / 4));

// A separator glyph stays with the word after it, so no row ends with `→` or `·`.
const wrapUnits = (text: string): string[] => {
  const units: string[] = [];
  for (const word of Str.split(text, " ")) {
    const previous = Option.getOrUndefined(Arr.last(units));
    if (previous === "→" || previous === "·") units[units.length - 1] = `${previous} ${word}`;
    else units.push(word);
  }
  return units;
};

// Greedy word wrap whose first row may be wider than the rest.
const wrapWords = (text: string, firstWidth: number, restWidth: number): string[] => {
  const rows: string[] = [];
  let current = "";
  const limit = () => (rows.length === 0 ? firstWidth : restWidth);
  for (const word of wrapUnits(text)) {
    if (!current && !word && rows.length > 0) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= limit()) {
      current = candidate;
      continue;
    }
    if (visibleWidth(word) <= restWidth) {
      if (current) rows.push(current);
      current = word;
      continue;
    }
    // A word too wide for any row fills the current one first, unless too little of it fits there.
    const room = current ? limit() - visibleWidth(current) - 1 : limit();
    let pieces = breakWideWord(word, Math.max(0, room), restWidth);
    if (current && visibleWidth(pieces[0] ?? "") < meaningfulHead(restWidth)) {
      rows.push(current);
      current = "";
      pieces = breakWideWord(word, restWidth, restWidth);
    }
    const [head = "", ...tail] = pieces;
    const filled = head && current ? `${current} ${head}` : head || current;
    if (tail.length === 0) {
      current = filled;
      continue;
    }
    if (filled) rows.push(filled);
    rows.push(...tail.slice(0, -1));
    current = Option.getOrElse(Arr.last(tail), () => "");
  }
  if (current || rows.length === 0) rows.push(current);
  return rows;
};

/**
 * Wraps `·`-joined facts between whole facts, so no `·` or `→` ends a line; every line after the
 * first hangs under it. A fact too wide for a line breaks before its `→`, which then leads the
 * continuation (`→ provider/model`); a part still too wide breaks between words, then after a
 * `/`. Widths of 8 or less drop the hanging indent. Pass plain text and style the lines.
 */
export const wrapFacts = (facts: string, width: number, hangingIndent = "  "): string[] => {
  const hanging = width > 8 ? hangingIndent : "";
  const room = Math.max(1, width - visibleWidth(hanging));
  const pieces = Arr.flatMap(Str.split(facts, INLINE_SEPARATOR), (fact) => {
    if (visibleWidth(fact) <= room) return [{ text: fact, join: INLINE_SEPARATOR }];
    const [first, ...rest] = Str.split(fact, FACT_ARROW);
    return [
      { text: first, join: INLINE_SEPARATOR },
      ...Arr.map(rest, (part) => ({ text: `→ ${part}`, join: " " })),
    ];
  });
  const lines: string[] = [];
  let current = "";
  const limit = () => (lines.length === 0 ? width : room);
  for (const piece of pieces) {
    const candidate = current ? `${current}${piece.join}${piece.text}` : piece.text;
    if (visibleWidth(candidate) <= limit()) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // An over-wide piece starts its own line; the facts after it keep packing onto its last row.
    const rows = wrapWords(piece.text, limit(), room);
    lines.push(...rows.slice(0, -1));
    current = Option.getOrElse(Arr.last(rows), () => "");
  }
  if (current) lines.push(current);
  return Arr.map(lines, (line, index) => (index === 0 ? line : `${hanging}${line}`));
};

// visibleWidth caches and has an ASCII fast path; truncateToWidth segments any non-ASCII text.
export const clipToWidth = (text: string, width: number, marker = "…"): string => {
  if (width > 0 && visibleWidth(text) <= width) return text;
  const clipped = truncateToWidth(text, width, marker);
  return marker ? closeUpMarker(clipped, marker) : clipped;
};

export const managerTabs = (tabs: ReadonlyArray<string>, active: number, width: number): string => {
  const full = `  ${Arr.join(tabs, "  ")}`;
  return visibleWidth(full) <= width
    ? full
    : truncateToWidth(`  ${tabs[active] ?? ""}`, Math.max(0, width), "");
};
