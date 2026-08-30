import type { ResolvedSubagentConfig } from "../config/options.ts";
import {
  cloneSessionProfileOverrideSeed,
  emptySessionProfileOverrideSeed,
  type SessionProfileOverrideSeed,
} from "../profiles/session-overrides.ts";

export interface ProfileOverrideHandoff {
  readonly capture: () => SessionProfileOverrideSeed;
  /** Present after the runtime publishes its complete frozen session baseline and overlays. */
  readonly captureAuthoritative: () => SessionProfileOverrideSeed | undefined;
  readonly captureBaseConfig: () => ResolvedSubagentConfig | undefined;
  readonly publishBaseConfig: (
    ownerGeneration: number,
    currentGeneration: number,
    config: ResolvedSubagentConfig,
  ) => void;
  readonly publish: (
    ownerGeneration: number,
    currentGeneration: number,
    seed: SessionProfileOverrideSeed,
  ) => void;
  readonly clear: () => void;
}

/**
 * Keeps the complete detached session profile baseline, sparse edits, and nesting across `/tree`.
 * Real Pi session lifecycle boundaries clear this host-owned handoff explicitly.
 */
export const makeProfileOverrideHandoff = (): ProfileOverrideHandoff => {
  let seed = emptySessionProfileOverrideSeed();
  let seedIsAuthoritative = false;
  let baseConfig: ResolvedSubagentConfig | undefined;
  return {
    capture: () => cloneSessionProfileOverrideSeed(seed),
    captureAuthoritative: () =>
      seedIsAuthoritative ? cloneSessionProfileOverrideSeed(seed) : undefined,
    captureBaseConfig: () => baseConfig,
    publishBaseConfig: (ownerGeneration, currentGeneration, config) => {
      if (ownerGeneration === currentGeneration) baseConfig = config;
    },
    publish: (ownerGeneration, currentGeneration, next) => {
      if (ownerGeneration === currentGeneration) {
        seed = cloneSessionProfileOverrideSeed(next);
        seedIsAuthoritative = true;
      }
    },
    clear: () => {
      seed = emptySessionProfileOverrideSeed();
      seedIsAuthoritative = false;
      baseConfig = undefined;
    },
  };
};
