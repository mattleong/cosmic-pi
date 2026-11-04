import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { clipToWidth } from "./chrome.ts";
import type { FullScreenSelectionKeybindingId } from "./keymap.ts";

const SPECIAL_KEY_LABELS = new Map<string, string>(
  Rec.toEntries({
    up: "↑",
    down: "↓",
    left: "←",
    right: "→",
    enter: "Enter",
    escape: "Esc",
    pageUp: "PgUp",
    pageDown: "PgDn",
    home: "Home",
    end: "End",
    tab: "Tab",
    space: "Space",
  }),
);

const MODIFIER_LABELS = new Map<string, string>(
  Rec.toEntries({
    ctrl: "C-",
    shift: "⇧",
    alt: "A-",
    super: "⌘",
  }),
);

const formatFullScreenKeyId = (value: string): string => {
  const parts = Str.split(value, "+");
  const base = parts.pop() ?? value;
  const modifiers = Arr.join(
    Arr.map(parts, (part) => MODIFIER_LABELS.get(part) ?? `${part}-`),
    "",
  );
  const label = SPECIAL_KEY_LABELS.get(base) ?? base;
  return `${modifiers}${parts.includes("shift") && base.length === 1 ? Str.toUpperCase(label) : label}`;
};

/** Formats Pi key ids (`ctrl+g`, `escape`) as hint labels (`C-g`, `Esc`) joined by `/`. */
export const formatKeyIds = (keys: ReadonlyArray<string>): string =>
  Arr.join(Arr.map(keys, formatFullScreenKeyId), "/");

export interface HostKeybindingSource {
  readonly matches: (data: string, id: FullScreenSelectionKeybindingId) => boolean;
  readonly getKeys?: (id: FullScreenSelectionKeybindingId) => ReadonlyArray<string>;
}

export const fullScreenKeybindingOptions = (keybindings: HostKeybindingSource) => ({
  matchesKeybinding: (data: string, id: FullScreenSelectionKeybindingId) =>
    keybindings.matches(data, id),
  keybindingLabel: (id: FullScreenSelectionKeybindingId, fallback: string) =>
    formatKeyIds(
      Predicate.isFunction(keybindings.getKeys) ? keybindings.getKeys(id) : Arr.empty<string>(),
    ) || fallback,
});

const SHIFT_LABEL_PREFIX = "⇧";

const filterReservedKeyLabel = (
  label: string,
  reservedKeys: ReadonlySet<string>,
  fallback: string,
): string => {
  if (label === "/") return reservedKeys.has("/") ? fallback : label;
  // Widened so the negated Arr.some guard cannot narrow the non-empty split result to never.
  const parts: ReadonlyArray<string> = Str.split(label, "/");
  if (Arr.some(parts, (part) => part.length === 0)) return label;
  const collides = (part: string): boolean =>
    reservedKeys.has(part) ||
    (part.length === 2 &&
      Fn.pipe(part, Str.startsWith(SHIFT_LABEL_PREFIX)) &&
      reservedKeys.has(Fn.pipe(part, Str.slice(SHIFT_LABEL_PREFIX.length))));
  return (
    Arr.join(
      Arr.filter(parts, (part) => !collides(part)),
      "/",
    ) || fallback
  );
};

export const TEXT_INPUT_KEY_LABELS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)),
  "Space",
  "⇧Space",
]);

/*
 * Suite key-hint convention (docs/architecture/ui-conventions.md):
 * - Hints are `Key Verb` pairs with Title Case verbs joined by ` · `.
 * - The default bar stays short; `? More` expands to a superset that adds aliases and extra keys
 *   and toggles to `? Less`. Never replace default hints when expanded.
 * - `Esc` backs out one level: `Esc Back` when nested, `Esc Close` at the top level, and
 *   `Esc Cancel` for a pending decision. `q`/`h` aliases appear only in expanded help.
 * - Settings rows say what Enter does: `Enter Toggle`, `Enter Change`, or `Enter Open`.
 */

export const KEY_HINT_SEPARATOR = " · ";

export type KeyHintPart = string | false | null | undefined;

const presentHints = (parts: ReadonlyArray<KeyHintPart>): ReadonlyArray<string> =>
  Arr.filter(parts, (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part));

/** `keyHint("Enter", "Inspect")` → `Enter Inspect`. */
export const keyHint = (key: string, verb: string): string => `${key} ${verb}`;

/** Joins hint pairs with the suite separator, skipping empty or disabled parts. */
export const joinKeyHints = (parts: ReadonlyArray<KeyHintPart>): string =>
  Arr.join(presentHints(parts), KEY_HINT_SEPARATOR);

/** `top` closes the surface, `nested` returns one level, `decision` cancels a pending choice. */
export type SurfaceExitLevel = "top" | "nested" | "decision";

const EXIT_VERBS = {
  top: "Close",
  nested: "Back",
  decision: "Cancel",
} satisfies Readonly<Record<SurfaceExitLevel, string>>;

export const exitKeyVerb = (level: SurfaceExitLevel): string => EXIT_VERBS[level];

/** `Esc Close`, `Esc Back`, or `Esc Cancel`; aliases such as `q` belong to expanded help only. */
export const exitKeyHint = (
  level: SurfaceExitLevel,
  aliases: ReadonlyArray<string> = [],
  key = "Esc",
): string => keyHint(Arr.join([key, ...aliases], "/"), exitKeyVerb(level));

/** `? More` while collapsed and `? Less` while expanded. */
export const helpKeyHint = (expanded: boolean, key = "?"): string =>
  keyHint(key, expanded ? "Less" : "More");

export const moveKeyHint = (key = "↑↓"): string => keyHint(key, "Move");

/** What Enter does on a settings row: booleans toggle, enums open a choice list, groups open. */
export type SettingAffordance = "toggle" | "change" | "open";

const SETTING_AFFORDANCE_VERBS = {
  toggle: "Toggle",
  change: "Change",
  open: "Open",
} satisfies Readonly<Record<SettingAffordance, string>>;

export const settingAffordanceHint = (affordance: SettingAffordance, key = "Enter"): string =>
  keyHint(key, SETTING_AFFORDANCE_VERBS[affordance]);

export interface KeyHintBar {
  /** Default actions, most important first. They stay visible when help is expanded. */
  readonly hints: ReadonlyArray<KeyHintPart>;
  /** Additional keys and aliases shown only while help is expanded. */
  readonly more?: ReadonlyArray<KeyHintPart> | undefined;
  /** Exit key for this level; omit when the surface has no exit of its own. */
  readonly exit?: SurfaceExitLevel | undefined;
  /** Exit aliases such as `q`; shown only while help is expanded. */
  readonly exitAliases?: ReadonlyArray<string> | undefined;
  /** The configured exit key label; defaults to `Esc`. */
  readonly exitKey?: string | undefined;
}

/**
 * Composes a suite hint bar: `hints · exit · ? More`, or, expanded,
 * `hints · more · exit/aliases · ? Less`. `? More` appears only when expansion adds something.
 */
export const keyHintBar = (bar: KeyHintBar, expanded: boolean): string => {
  const more = presentHints(bar.more ?? []);
  const aliases = bar.exitAliases ?? [];
  const expandable = more.length > 0 || (bar.exit !== undefined && aliases.length > 0);
  return joinKeyHints([
    ...bar.hints,
    ...(expanded ? more : []),
    bar.exit && exitKeyHint(bar.exit, expanded ? aliases : [], bar.exitKey),
    expandable && helpKeyHint(expanded),
  ]);
};

/**
 * Packs hint pairs into rows no wider than `width`, breaking only between pairs so a key never
 * separates from its verb. A single pair wider than `width` gets its own row.
 */
export const wrapKeyHints = (hint: string, width: number): string[] => {
  const safeWidth = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let current = "";
  for (const pair of Str.split(hint, KEY_HINT_SEPARATOR)) {
    const candidate = current ? `${current}${KEY_HINT_SEPARATOR}${pair}` : pair;
    if (current && visibleWidth(candidate) > safeWidth) {
      rows.push(current);
      current = pair;
    } else current = candidate;
  }
  if (current) rows.push(current);
  return rows;
};

/**
 * A hint bar as styled surface rows: wrapped between pairs to fit `width` with a one-column
 * gutter on each side. Every pair survives, so Move and Esc stay visible at narrow widths.
 */
export const keyHintRows = (
  hint: string,
  width: number,
  style: (row: string) => string = Fn.identity,
): string[] => {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0 || !hint) return [];
  return Arr.map(wrapKeyHints(hint, Math.max(1, safeWidth - 2)), (row) =>
    clipToWidth(style(` ${row}`), safeWidth),
  );
};

export const configuredKeyLabels = (
  keybindingLabel: ((id: FullScreenSelectionKeybindingId, fallback: string) => string) | undefined,
  reserved: ReadonlySet<string>,
) => {
  const key = (id: FullScreenSelectionKeybindingId, fallback: string): string => {
    const configured = keybindingLabel?.(id, fallback);
    const label = configured === undefined || configured === "" ? fallback : configured;
    return filterReservedKeyLabel(label, reserved, fallback);
  };
  const movement = keybindingLabel
    ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
    : undefined;
  return { key, movement, navigation: movement ? `j/k · ${movement}` : "j/k" };
};
