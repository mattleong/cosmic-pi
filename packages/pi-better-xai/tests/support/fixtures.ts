import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistryAuth } from "../../src/boundary/model-registry-auth.ts";
import type { UsageSnapshot } from "../../src/usage/format.ts";

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged errors, redacted credentials) for secret fragments.
export const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

type Registry = ExtensionContext["modelRegistry"];

/** Pi registry double: each `getProviderAuth` call resolves `lookup()` as xAI auth; an Error rejects. */
export const registryDouble = (lookup: () => string | Error | undefined) => {
  const registry = {
    getProviderAuth: (): ReturnType<Registry["getProviderAuth"]> => {
      const token = lookup();
      if (token instanceof Error) return Promise.reject(token);
      return Promise.resolve(token === undefined ? undefined : { auth: { apiKey: token } });
    },
  };
  // SAFETY: The registry boundary and usage paths call only getProviderAuth on this double.
  return registry as typeof registry & Registry;
};

/** The real registry boundary over a Pi double that answers every lookup through `lookup`. */
export const registryLookupLayer = (lookup: () => string | Error | undefined) =>
  ModelRegistryAuth.layer(() => registryDouble(lookup));

export const registryLayer = (token?: string | Error) => registryLookupLayer(() => token);

export const usageSnapshot = (monthlyUsed: number, weeklyUsedPercent: number): UsageSnapshot => ({
  capturedAt: 0,
  weeklyUsedPercent,
  weeklyLeftPercent: 100 - weeklyUsedPercent,
  weeklyResetInSeconds: null,
  monthlyUsed,
  monthlyLimit: 1_000,
  monthlyLeftPercent: 100 - monthlyUsed / 10,
  monthlyResetInSeconds: null,
  onDemandCap: 500,
  onDemandUsed: 100,
});
