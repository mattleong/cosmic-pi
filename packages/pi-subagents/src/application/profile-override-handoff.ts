import type { ResolvedSubagentConfig } from "../config/options.ts";
import {
  cloneSessionProfileOverrideSeed,
  emptySessionProfileOverrideSeed,
  type SessionProfileOverrideSeed,
} from "../profiles/session-overrides.ts";

export const makeProfileOverrideHandoff = () => {
  let seed = emptySessionProfileOverrideSeed();
  let seedIsAuthoritative = false;
  let baseConfig: ResolvedSubagentConfig | undefined;
  let owner = 0;
  return {
    capture: () => cloneSessionProfileOverrideSeed(seed),
    captureAuthoritative: () =>
      seedIsAuthoritative ? cloneSessionProfileOverrideSeed(seed) : undefined,
    captureBaseConfig: () => baseConfig,
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
