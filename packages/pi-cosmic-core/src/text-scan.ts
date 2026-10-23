/**
 * Native string scans that `effect/String` cannot express. `Str.indexOf` and
 * `Str.lastIndexOf` take no start position, and `Str.charCodeAt` allocates an
 * `Option` per character, which hot scanners cannot afford. This is the only
 * module allowed to call these natives; the `preferEffectString` diagnostic is
 * disabled for this exact file.
 */

/** The first index of `search` at or after `from`, or -1 when absent. */
export const indexOfFrom = (text: string, search: string, from: number): number =>
  text.indexOf(search, from);

/** The last index of `search` at or before `from`, or -1 when absent. */
export const lastIndexOfFrom = (text: string, search: string, from: number): number =>
  text.lastIndexOf(search, from);

/** The UTF-16 code unit at `index`, or `NaN` when out of range. */
export const codeUnitAt = (text: string, index: number): number => text.charCodeAt(index);
