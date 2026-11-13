import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { wrapFacts } from "pi-cosmic-ui/manager";
import { cachedComponent } from "pi-cosmic-ui/tool";
import { escapeControlChars, wrapIndentedLine } from "../shared/terminal-text";
import { authoredTextLines } from "./authored-text";
import { compactPlainText } from "./compact-row";
import { expandedSection, unlabeledSection } from "./expanded-section";

/** Theme colors an expanded body draws plain text in. */
export type ExpandedTone = "toolOutput" | "muted" | "dim" | "error" | "warning" | "success";

/** One line of plain text, optionally in its own tone, such as stderr drawn as an error. */
export type ExpandedLine = string | { readonly text: string; readonly tone: ExpandedTone };

/** One labeled fact: a muted label in a shared column and its value lines. */
export interface ExpandedField {
  readonly label: string;
  /** Plain-text value lines; a multi-line value such as a command keeps its line breaks. */
  readonly lines: ReadonlyArray<ExpandedLine>;
}

type BodyTheme = Pick<Theme, "fg">;

const LABEL_GAP = 2;
// Field blocks with labels up to this width share one value column, so separate blocks align.
const MIN_LABEL_WIDTH = 12;
// Narrower values stack beneath their label instead of wrapping a few columns at a time.
const MIN_VALUE_WIDTH = 16;
// A value that wraps onto more rows than this in the value column stacks beneath its label.
const MAX_VALUE_ROWS = 3;

const pad = (width: number): string => Fn.pipe(" ", Str.repeat(width));

const plainParts = (text: string): string[] => Str.split(compactPlainText(text), "\n");

// A wrapped Details line hangs two columns past a nested fact, so it never reads as one.
const NESTED_INDENT = 2;
const DETAILS_HANGING = pad(NESTED_INDENT * 2);

/**
 * A plain line wrapped to `width` and drawn in its tone; long paths break after a separator. A
 * line of facts wraps between whole `·` facts with continuation rows hanging by `hanging` (two
 * columns unless given), so no row ends with `·` or `→`.
 */
const wrappedLine = (
  theme: BodyTheme,
  line: ExpandedLine,
  tone: ExpandedTone,
  width: number,
  facts = false,
  hanging?: string,
): string[] => {
  const text = Predicate.isString(line) ? line : line.text;
  const color = Predicate.isString(line) ? tone : line.tone;
  return Arr.flatMap(plainParts(text), (part) =>
    Arr.map(
      facts
        ? wrapFacts(part, Math.max(1, width), hanging)
        : wrapIndentedLine(part, Math.max(1, width)),
      (row) => (row === "" ? "" : theme.fg(color, row)),
    ),
  );
};

const linesComponent = (
  theme: BodyTheme,
  lines: ReadonlyArray<ExpandedLine>,
  tone: ExpandedTone,
): Component =>
  cachedComponent((width) => Arr.flatMap(lines, (line) => wrappedLine(theme, line, tone, width)));

/**
 * Labeled facts in a shared label column, indented beneath the heading. Wrapped values hang at the
 * value column; when the value column would be too narrow, each value stacks beneath its label, as
 * does a value that would wrap onto more than three rows there, such as a long command.
 */
export function expandedFields(theme: BodyTheme, fields: ReadonlyArray<ExpandedField>): Component {
  const shown = Arr.filter(fields, (field) => field.lines.length > 0);
  if (shown.length === 0) return new Container();
  const rows = cachedComponent((width) => {
    const labelWidth = Math.max(
      MIN_LABEL_WIDTH,
      ...Arr.map(shown, (field) => visibleWidth(field.label)),
    );
    const column = labelWidth + LABEL_GAP;
    const stacked = width - column < MIN_VALUE_WIDTH;
    const wrapped = (field: ExpandedField, room: number) =>
      Arr.flatMap(field.lines, (line) => wrappedLine(theme, line, "toolOutput", room, true));
    return Arr.flatMap(shown, (field) => {
      const label = theme.fg("muted", escapeControlChars(field.label));
      const beside = stacked ? [] : wrapped(field, width - column);
      const own = Arr.flatMap(field.lines, (line) =>
        plainParts(Predicate.isString(line) ? line : line.text),
      ).length;
      const wraps = beside.length > MAX_VALUE_ROWS && beside.length > own;
      if (stacked || wraps)
        return [label, ...Arr.map(wrapped(field, width - 2), (value) => `  ${value}`)];
      const labelPad = pad(Math.max(0, column - visibleWidth(field.label)));
      return Arr.map(beside, (value, index) =>
        index === 0 ? `${label}${labelPad}${value}` : `${pad(column)}${value}`,
      );
    });
  });
  return unlabeledSection(theme, rows);
}

/**
 * Plain text beneath an optional section label, wrapped and with controls made visible. Lines
 * default to the tool-output tone; a line can carry its own, such as stderr in the error tone.
 */
export function expandedText(
  theme: BodyTheme,
  label: string | undefined,
  lines: ReadonlyArray<ExpandedLine>,
  tone: ExpandedTone = "toolOutput",
): Component {
  if (lines.length === 0) return new Container();
  return expandedSection(theme, label, linesComponent(theme, lines, tone));
}

/**
 * Words an agent or session wrote, in full, rendered as markdown the way Pi renders assistant
 * text, beneath an optional section label.
 */
export function expandedAuthoredText(
  theme: Pick<Theme, "fg" | "bold">,
  label: string | undefined,
  text: string | undefined,
): Component {
  if (text === undefined || Str.trim(text) === "") return new Container();
  return expandedSection(
    theme,
    label,
    cachedComponent((width) =>
      authoredTextLines(text, width, theme, { expanded: true, indent: 0 }),
    ),
  );
}

/**
 * The expanded-only `Details` section: technical facts such as IDs, routes, paths, and usage, one
 * dim line each. Leading spaces nest a fact beneath the one before it, two columns per level; a
 * wrapped line breaks between whole `·` facts and hangs four columns beneath its first row, two past
 * a nested fact, so a continuation never sits in a nested fact's column.
 */
export function expandedDetails(
  theme: BodyTheme,
  lines: ReadonlyArray<string>,
  label = "Details",
): Component {
  const facts = Arr.filter(lines, (line) => Str.isNonEmpty(Str.trim(line)));
  if (facts.length === 0) return new Container();
  const rows = cachedComponent((width) =>
    Arr.flatMap(facts, (line) => {
      const nested = Math.min(line.length - Str.trimStart(line).length, Math.max(0, width - 2));
      const wrapped = wrappedLine(
        theme,
        Str.trim(line),
        "dim",
        width - nested,
        true,
        DETAILS_HANGING,
      );
      return Arr.map(wrapped, (row) => `${pad(nested)}${row}`);
    }),
  );
  return expandedSection(theme, label, rows);
}

/**
 * One expanded tool or message body: its parts stacked in order beneath the heading. Absent parts
 * and parts that draw nothing take no space.
 */
export function expandedBody(...parts: ReadonlyArray<Component | undefined>): Component {
  const present = Arr.filter(parts, Predicate.isNotUndefined);
  return {
    render: (width) => Arr.flatMap(present, (part) => part.render(width)),
    invalidate: () => {
      for (const part of present) part.invalidate();
    },
  };
}
