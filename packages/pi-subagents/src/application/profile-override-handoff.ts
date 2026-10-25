import type { ResolvedSubagentConfig } from "../config/options.ts";
import {
  cloneSessionProfileOverrideSeed,
  emptySessionProfileOverrideSeed,
  sessionProfileSeed,
  type SessionProfileOverrideSeed,
  type SessionProfileSnapshot,
} from "../profiles/session-overrides.ts";

export const createProfileOverrideHandoff = () => {
  let seed = emptySessionProfileOverrideSeed();
  let seedIsAuthoritative = false;
  let snapshot: SessionProfileSnapshot | undefined;
  let baseConfig: ResolvedSubagentConfig | undefined;
  let owner = 0;
  const publish = (from: number, next: SessionProfileOverrideSeed) => {
    if (from !== owner) return;
    seed = cloneSessionProfileOverrideSeed(next);
    seedIsAuthoritative = true;
  };
  return {
    capture: () => cloneSessionProfileOverrideSeed(seed),
    captureAuthoritative: () =>
      seedIsAuthoritative ? cloneSessionProfileOverrideSeed(seed) : undefined,
    /** The current owner's latest base configuration, which /tree keeps. */
    captureBaseConfig: () => baseConfig,
    /** The current owner's latest committed Current Session, for prompt and footer views. */
    captureSnapshot: () => snapshot,
    open: () => ++owner,
    publish,
    /** False when `from` no longer owns the handoff, so nothing was published. */
    publishSnapshot: (from: number, next: SessionProfileSnapshot): boolean => {
      if (from !== owner) return false;
      publish(from, sessionProfileSeed(next));
      snapshot = next;
      baseConfig = next.baseConfig;
      return true;
    },
    clear: () => {
      owner += 1;
      seed = emptySessionProfileOverrideSeed();
      seedIsAuthoritative = false;
      snapshot = undefined;
      baseConfig = undefined;
    },
  };
};
