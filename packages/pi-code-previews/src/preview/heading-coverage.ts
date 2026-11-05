/**
 * Whether a row's expanded heading showed its whole subject when it last drew. The heading draws
 * before the row's body in the same pass, so a body can leave out input the heading already shows
 * and still show it whenever the heading clips it. Keyed by the row's renderer state.
 */
const subjectShown = new WeakMap<WeakKey, boolean>();

export const recordHeadingSubject = (state: WeakKey, complete: boolean): void => {
  subjectShown.set(state, complete);
};

/** False until a heading has drawn, so a body never drops input on a guess. */
export const headingShowedSubject = (state: WeakKey): boolean => subjectShown.get(state) === true;

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
