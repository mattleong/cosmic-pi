import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
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

// A label made only of modifiers (`C-`, `A-⇧`) is still waiting for its key, so a `/` after it is
// the key itself rather than a separator.
const MODIFIERS_ONLY = /^(?:C-|A-|⇧|⌘)+$/;

/**
 * Splits a `/`-joined key label (`Esc/C-c`) into its keys, keeping `/` itself as a key: `/`,
 * `C-/`, and `Esc//` read as `["/"]`, `["C-/"]`, and `["Esc", "/"]`.
 */
export const splitKeyLabel = (label: string): ReadonlyArray<string> => {
  const keys: string[] = [];
  let current = "";
  for (const char of label) {
    if (char === "/" && current !== "" && !MODIFIERS_ONLY.test(current)) {
      keys.push(current);
      current = "";
    } else current = `${current}${char}`;
  }
  return current === "" ? keys : [...keys, current];
};

const filterReservedKeyLabel = (
  label: string,
  reservedKeys: ReadonlySet<string>,
  fallback: string,
): string => {
  const collides = (part: string): boolean =>
    reservedKeys.has(part) ||
    (part.length === 2 &&
      Fn.pipe(part, Str.startsWith(SHIFT_LABEL_PREFIX)) &&
      reservedKeys.has(Fn.pipe(part, Str.slice(SHIFT_LABEL_PREFIX.length))));
  return (
    Arr.join(
      Arr.filter(splitKeyLabel(label), (part) => !collides(part)),
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

export interface KeyHintBarParts {
  /** The surface's own pairs, plus `more` while expanded. */
  readonly hints: ReadonlyArray<string>;
  /** The exit and the help toggle, which a framed surface keeps in its border. */
  readonly tail: ReadonlyArray<string>;
}

/**
 * The pairs of a suite hint bar, split so a framed surface can keep the exit and `? More` in its
 * border. Expanded, the exit names every alias in one pair, `Esc/C-c/q Close`.
 */
export const keyHintBarParts = (bar: KeyHintBar, expanded: boolean): KeyHintBarParts => {
  const more = presentHints(bar.more ?? []);
  const aliases = bar.exitAliases ?? [];
  const expandable = more.length > 0 || (bar.exit !== undefined && aliases.length > 0);
  return {
    hints: presentHints([...bar.hints, ...(expanded ? more : [])]),
    tail: presentHints([
      bar.exit && exitKeyHint(bar.exit, expanded ? aliases : [], bar.exitKey),
      expandable && helpKeyHint(expanded),
    ]),
  };
};

/**
 * Composes a suite hint bar: `hints · exit · ? More`, or, expanded,
 * `hints · more · exit/aliases · ? Less`. `? More` appears only when expansion adds something.
 */
export const keyHintBar = (bar: KeyHintBar, expanded: boolean): string => {
  const { hints, tail } = keyHintBarParts(bar, expanded);
  return joinKeyHints([...hints, ...tail]);
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

// A bar in the border keeps a corner and a rule on each side of it.
const fitsBorder = (hint: string, inner: number): boolean => visibleWidth(hint) + 2 <= inner;

/**
 * ` hint ` for a framed surface's bottom border. It is clipped with `…` only when even the
 * border's own pairs cannot fit; surfaces with more hints use `framedKeyHints`.
 */
export const borderKeyHint = (hint: string, inner: number): string => {
  const safeWidth = Math.max(0, Math.floor(inner));
  if (safeWidth === 0 || !hint) return "";
  return clipToWidth(` ${hint} `, safeWidth, "…");
};

/** Short and long forms of a bar: the border shows the long one when it fits. */
export const fittedBorderKeyHint = (long: string, short: string, inner: number): string =>
  borderKeyHint(fitsBorder(long, inner) ? long : short, inner);

export interface FramedKeyHints {
  /** Text for the bottom border. */
  readonly border: string;
  /** Pairs that didn't fit the border; wrap them into rows above it with `keyHintRows`. */
  readonly overflow: string;
}

/**
 * Lays out a framed surface's hint bar. The whole bar sits in the bottom border when it fits.
 * Otherwise the border keeps `tail`, normally the exit and `? More`, and the other pairs wrap
 * into rows above it, so no hint is dropped at any width.
 */
export const framedKeyHints = (
  hints: ReadonlyArray<KeyHintPart>,
  tail: ReadonlyArray<KeyHintPart>,
  inner: number,
): FramedKeyHints => {
  const full = joinKeyHints([...hints, ...tail]);
  if (fitsBorder(full, inner)) return { border: borderKeyHint(full, inner), overflow: "" };
  return { border: borderKeyHint(joinKeyHints(tail), inner), overflow: joinKeyHints(hints) };
};

/** `keyHintBar` laid out for a framed surface: the border keeps the exit and the help toggle. */
export const framedKeyHintBar = (
  bar: KeyHintBar,
  expanded: boolean,
  inner: number,
): FramedKeyHints => {
  const { hints, tail } = keyHintBarParts(bar, expanded);
  return framedKeyHints(hints, tail, inner);
};

/** `↑↓` when both keys are one glyph, `C-p/C-n` otherwise; never `↑/↓`. */
export const movementKeyLabel = (up: string, down: string): string =>
  Str.length(up) === 1 && Str.length(down) === 1 ? `${up}${down}` : `${up}/${down}`;

/** A configured binding as a hint key: the primary key, and aliases for expanded help. */
export interface ConfiguredKey {
  readonly key: string;
  readonly aliases: ReadonlyArray<string>;
}

const configuredKey = (label: string, fallback: string): ConfiguredKey => {
  const [key, ...aliases] = splitKeyLabel(label);
  return { key: key ?? fallback, aliases };
};

/**
 * Hint labels for the `tui.select.*` keys a surface was configured with. `key` keeps every
 * configured key (`Esc/C-c`); default bars use `primary` and put `aliases` in expanded help, and
 * `movement` names the primary up and down keys as one label (`↑↓`).
 */
export const configuredKeyLabels = (
  keybindingLabel: ((id: FullScreenSelectionKeybindingId, fallback: string) => string) | undefined,
  reserved: ReadonlySet<string>,
) => {
  const key = (id: FullScreenSelectionKeybindingId, fallback: string): string => {
    const configured = keybindingLabel?.(id, fallback);
    const label = configured === undefined || configured === "" ? fallback : configured;
    return filterReservedKeyLabel(label, reserved, fallback);
  };
  const binding = (id: FullScreenSelectionKeybindingId, fallback: string): ConfiguredKey =>
    configuredKey(key(id, fallback), fallback);
  const primary = (id: FullScreenSelectionKeybindingId, fallback: string): string =>
    binding(id, fallback).key;
  const movement = keybindingLabel
    ? movementKeyLabel(primary("tui.select.up", "↑"), primary("tui.select.down", "↓"))
    : undefined;
  return {
    key,
    binding,
    primary,
    movement,
    navigation: movement ? `j/k · ${movement}` : "j/k",
  };
};

const piSelectKeyLabel = (id: FullScreenSelectionKeybindingId, fallback: string): string =>
  invokeHostCallback((): string => {
    const keys: unknown = getKeybindings().getKeys(id);
    return Arr.isArray(keys) ? formatKeyIds(Arr.filter(keys, Predicate.isString)) : fallback;
  }, fallback);

/**
 * Pi's own select keys, as surfaces built on pi-tui lists (settings lists and their choice
 * submenus) match them: the primary keys for the default bar and the cancel aliases, such as
 * `C-c`, for expanded help. Unreadable bindings fall back to the default keys.
 */
export const piSelectHintKeys = () => {
  const keys = configuredKeyLabels(piSelectKeyLabel, new Set());
  const cancel = keys.binding("tui.select.cancel", "Esc");
  return {
    move: keys.movement ?? "↑↓",
    confirm: keys.primary("tui.select.confirm", "Enter"),
    cancel: cancel.key,
    cancelAliases: cancel.aliases,
  };
};
