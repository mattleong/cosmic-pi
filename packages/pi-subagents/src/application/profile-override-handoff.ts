import type { ResolvedSubagentConfig } from "../config/options.ts";
import {
  cloneSessionProfileOverrideSeed,
  emptySessionProfileOverrideSeed,
  type SessionProfileOverrideSeed,
} from "../profiles/session-overrides.ts";

/**
 * Keeps the complete detached session profile baseline, sparse edits, and nesting across `/tree`.
 * Only the runtime that opened it last may publish; real Pi session lifecycle boundaries clear
 * this host-owned handoff explicitly, which also retires that runtime.
 */
export const makeProfileOverrideHandoff = () => {
  let seed = emptySessionProfileOverrideSeed();
  let seedIsAuthoritative = false;
  let baseConfig: ResolvedSubagentConfig | undefined;
  let owner = 0;
  return {
    capture: () => cloneSessionProfileOverrideSeed(seed),
    /** Present after the runtime publishes its complete frozen session baseline and overlays. */
    captureAuthoritative: () =>
      seedIsAuthoritative ? cloneSessionProfileOverrideSeed(seed) : undefined,
    captureBaseConfig: () => baseConfig,
    /** Makes a new runtime the only publisher and returns its owner token. */
    open: () => ++owner,
    publishBaseConfig: (from: number, config: ResolvedSubagentConfig) => {
      if (from === owner) baseConfig = config;
    },
    publish: (from: number, next: SessionProfileOverrideSeed) => {
      if (from !== owner) return;
      seed = cloneSessionProfileOverrideSeed(next);
      seedIsAuthoritative = true;
    },
    clear: () => {
      owner += 1;
      seed = emptySessionProfileOverrideSeed();
      seedIsAuthoritative = false;
      baseConfig = undefined;
    },
  };
};
