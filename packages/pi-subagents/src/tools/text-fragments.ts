import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";

/** Keeps the present, non-empty fragments of optional display text before joining. */
export const isTextFragment = (fragment: string | false | null | undefined): fragment is string =>
  Predicate.isString(fragment) && Str.isNonEmpty(fragment);
