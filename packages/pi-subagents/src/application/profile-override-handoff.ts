import {
  emptySessionProfileOverrideSeed,
  sessionProfileSeed,
  type SessionProfileSnapshot,
} from "../profiles/session-overrides.ts";

export const createProfileOverrideHandoff = () => {
  let snapshot: SessionProfileSnapshot | undefined;
  let owner = 0;
  return {
    capture: () => (snapshot ? sessionProfileSeed(snapshot) : emptySessionProfileOverrideSeed()),
    captureAuthoritative: () => snapshot && sessionProfileSeed(snapshot),
    /** The current owner's latest base configuration, which /tree keeps. */
    captureBaseConfig: () => snapshot?.baseConfig,
    /** The current owner's latest committed current session, for prompt and footer views. */
    captureSnapshot: () => snapshot,
    open: () => ++owner,
    /** False when `from` no longer owns the handoff, so nothing was published. */
    publishSnapshot: (from: number, next: SessionProfileSnapshot): boolean => {
      if (from !== owner) return false;
      snapshot = next;
      return true;
    },
    clear: () => {
      owner += 1;
      snapshot = undefined;
    },
  };
};
