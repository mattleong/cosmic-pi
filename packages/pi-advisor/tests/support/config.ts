import type { ResolvedAdvisorConfig } from "../../src/config/options.ts";

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
