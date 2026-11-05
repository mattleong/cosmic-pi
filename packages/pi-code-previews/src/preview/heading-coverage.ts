import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";

/**
 * Whether a row's expanded heading showed its whole subject when it last drew. The heading draws
 * before the row's body in the same pass, so a body can leave out input the heading already shows
 * and still show it whenever the heading clips it. Keyed by the row's renderer state.
 */
const subjectShown = new WeakMap<WeakKey, boolean>();

/** How many rows a row's expanded heading drew when it last drew. Keyed by the row's renderer state. */
const rowsShown = new WeakMap<WeakKey, number>();

const endsClipped = (row: string): boolean =>
  Str.endsWith("…")(Str.trimEnd(stripTerminalControls(row)));

/**
 * Records the heading rows just drawn. A row that ends in `…` clipped something, so a heading that
 * draws one never reports its subject complete, whatever its layout claimed.
 */
export const recordHeadingSubject = (
  state: WeakKey,
  complete: boolean,
  rows: readonly string[],
): void => {
  subjectShown.set(state, complete && !Arr.some(rows, endsClipped));
  rowsShown.set(state, rows.length);
};

/**
 * Whether a row's expanded heading wrapped onto continuation rows, which hang where an unlabeled body
 * would sit, so a body beneath it labels itself. False until a heading has drawn.
 */
export const headingWrapped = (state: WeakKey): boolean => (rowsShown.get(state) ?? 0) > 1;

/** False until a heading has drawn, so a body never drops input on a guess. */
export const headingShowedSubject = (state: WeakKey): boolean => subjectShown.get(state) === true;

/**
 * The counter a row's expanded compact heading showed when it last drew, as plain text, so a body can
 * leave out an option the counter already states, such as grep's limit beside `limit reached: 2`.
 * Keyed by the row's renderer state.
 */
const counterShown = new WeakMap<WeakKey, string>();

export const recordHeadingCounter = (state: WeakKey, counter: string | undefined): void => {
  if (counter === undefined) counterShown.delete(state);
  else counterShown.set(state, counter);
};

/** Undefined until a heading has drawn a counter, so a body never drops input on a guess. */
export const headingCounter = (state: WeakKey): string | undefined => counterShown.get(state);

/**
 * Whether a row's expanded heading is the tool's own collapsed preview call, which may show input
 * beyond the subject, such as grep's glob and limit. Keyed by the row's renderer state.
 */
const ownCallShown = new WeakMap<WeakKey, boolean>();

export const recordOwnCallHeading = (state: WeakKey, own: boolean): void => {
  ownCallShown.set(state, own);
};

/** False until a heading has drawn, so a body never drops input on a guess. */
export const headingIsOwnCall = (state: WeakKey): boolean => ownCallShown.get(state) === true;
