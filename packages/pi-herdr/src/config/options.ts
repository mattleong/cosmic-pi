import type { HerdrConfig } from "./schema.ts";
import { DEFAULT_HERDR_CONFIG } from "./schema.ts";

export type HerdrConfigInput = Partial<HerdrConfig>;

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(minimum, Math.min(maximum, Math.floor(value)));

export const normalizeHerdrConfig = (input: HerdrConfigInput): HerdrConfig => ({
  enabled: input.enabled ?? DEFAULT_HERDR_CONFIG.enabled,
  ...(input.session?.trim() ? { session: input.session.trim() } : {}),
  pollIntervalMs: boundedInteger(
    input.pollIntervalMs,
    DEFAULT_HERDR_CONFIG.pollIntervalMs,
    250,
    10_000,
  ),
  showFooterStatus: input.showFooterStatus ?? DEFAULT_HERDR_CONFIG.showFooterStatus,
  maxRetained: boundedInteger(input.maxRetained, DEFAULT_HERDR_CONFIG.maxRetained, 10, 1_000),
});
