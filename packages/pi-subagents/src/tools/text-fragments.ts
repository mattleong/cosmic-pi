/** Keeps the present, non-empty fragments of optional display text before joining. */
export const isTextFragment = (fragment: string | false | null | undefined): fragment is string =>
  Boolean(fragment);
