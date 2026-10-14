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
    captureBaseConfig: () => baseConfig,
    /** The current owner's latest committed Current Session, for prompt and footer views. */
    captureSnapshot: () => snapshot,
    open: () => ++owner,
    publishBaseConfig: (from: number, config: ResolvedSubagentConfig) => {
      if (from === owner) baseConfig = config;
    },
    publish,
    publishSnapshot: (from: number, next: SessionProfileSnapshot) => {
      if (from !== owner) return;
      publish(from, sessionProfileSeed(next));
      snapshot = next;
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
