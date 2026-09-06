import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { JsonObject } from "pi-cosmic-core";
import {
  normalizeAdvisorConfig,
  patchAdvisorConfig,
  type ResolvedAdvisorConfig,
} from "../../src/config/options.ts";
import { AdvisorConfigStoreError, ConfigStore } from "../../src/config/store.ts";

/** Owns a private JSON document and publishes only after the patch commits. */
export function memoryAdvisorConfigStore(initial: ResolvedAdvisorConfig, patchError?: string) {
  let document: JsonObject = {
    enabled: initial.enabled,
    setupDismissed: initial.setupDismissed,
  };
  if (initial.provider) document.provider = initial.provider;
  if (initial.model) document.model = initial.model;
  return Layer.succeed(
    ConfigStore,
    ConfigStore.of({
      load: (path = initial.configPath) => Effect.succeed(normalizeAdvisorConfig(document, path)),
      patch: (patch, path = initial.configPath, afterCommit) => {
        if (patchError)
          return Effect.fail(
            new AdvisorConfigStoreError({ operation: "update", message: patchError }),
          );
        document = patchAdvisorConfig(document, patch);
        const next = normalizeAdvisorConfig(document, path);
        return (afterCommit ? afterCommit(next) : Effect.void).pipe(Effect.as(next));
      },
    }),
  );
}

/**
 * A fully configured resolved Advisor config. Call sites override the exact
 * provider/model/path values their assertions depend on.
 */
export function resolvedAdvisorConfig(
  overrides: Partial<ResolvedAdvisorConfig> = {},
): ResolvedAdvisorConfig {
  return {
    configPath: "/tmp/pi-advisor.json",
    enabled: true,
    provider: "p",
    model: "m",
    setupDismissed: true,
    configured: true,
    ...overrides,
  };
}
