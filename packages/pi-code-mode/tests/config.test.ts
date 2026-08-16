// Async test bodies are Promise-shaped Vitest boundaries.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { findCodeModeSettingDescriptor, resolveCodeModeConfig } from "../src/config/options.ts";
import {
  CODE_MODE_FIELD_IDS,
  CODE_MODE_INTEGER_BOUNDS,
  DEFAULT_CODE_MODE_CONFIG,
} from "../src/config/schema.ts";

describe("code mode config resolution", () => {
  it("uses locked defaults when no scope defines a field", () => {
    const { config, provenance } = resolveCodeModeConfig(undefined, undefined);
    expect(config).toEqual({
      enabled: true,
      timeoutMs: 30_000,
      maxToolCalls: 32,
      maxOutputBytes: 51_200,
      maxSourceBytes: 32_768,
      maxCumulativeChildOutputBytes: 2_097_152,
      catalogBudget: 2_000,
    });
    for (const field of CODE_MODE_FIELD_IDS) expect(provenance[field]).toBe("default");
  });

  it("overlays project over global over defaults one field at a time", () => {
    const { config, provenance } = resolveCodeModeConfig(
      { timeoutMs: 60_000, enabled: false },
      { enabled: true, maxToolCalls: 64 },
    );
    expect(config.timeoutMs).toBe(60_000);
    expect(provenance.timeoutMs).toBe("global");
    expect(config.enabled).toBe(true);
    expect(provenance.enabled).toBe("project");
    expect(config.maxToolCalls).toBe(64);
    expect(provenance.maxToolCalls).toBe("project");
    expect(config.maxOutputBytes).toBe(DEFAULT_CODE_MODE_CONFIG.maxOutputBytes);
    expect(provenance.maxOutputBytes).toBe("default");
  });

  it("returns frozen plain resolved values and frozen defaults", () => {
    const { config, provenance } = resolveCodeModeConfig({ timeoutMs: 5_000 }, undefined);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CODE_MODE_CONFIG)).toBe(true);
  });

  it("documents defensible bounds around every numeric default", () => {
    for (const [field, bounds] of Object.entries(CODE_MODE_INTEGER_BOUNDS)) {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const defaultValue = DEFAULT_CODE_MODE_CONFIG[field as keyof typeof CODE_MODE_INTEGER_BOUNDS];
      expect(bounds.minimum).toBeLessThanOrEqual(defaultValue);
      expect(bounds.maximum).toBeGreaterThanOrEqual(defaultValue);
      expect(Number.isSafeInteger(bounds.minimum)).toBe(true);
      expect(Number.isSafeInteger(bounds.maximum)).toBe(true);
    }
    expect(CODE_MODE_INTEGER_BOUNDS.timeoutMs.minimum).toBe(1);
    expect(CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.minimum).toBe(1);
    expect(CODE_MODE_INTEGER_BOUNDS.maxToolCalls.minimum).toBe(0);
  });
});

describe("code mode setting descriptors", () => {
  it("parses bounded integers and rejects malformed or out-of-range input", async () => {
    const descriptor = findCodeModeSettingDescriptor("timeoutMs");
    expect(descriptor).toBeDefined();
    await expect(Effect.runPromise(descriptor!.decode("60000"))).resolves.toBe(60_000);
    await expect(Effect.runPromise(descriptor!.decode(" 250 "))).resolves.toBe(250);
    for (const raw of ["nope", "1.5", "1e3", "", "0", "-1", "600001", "99999999999999999999"]) {
      const error = await Effect.runPromise(descriptor!.decode(raw).pipe(Effect.flip));
      expect(error._tag).toBe("InvalidCodeModeSettingError");
      expect(error.message).toContain("timeoutMs");
    }
  });

  it("parses booleans strictly", async () => {
    const descriptor = findCodeModeSettingDescriptor("enabled");
    await expect(Effect.runPromise(descriptor!.decode("true"))).resolves.toBe(true);
    await expect(Effect.runPromise(descriptor!.decode("false"))).resolves.toBe(false);
    const error = await Effect.runPromise(descriptor!.decode("yes").pipe(Effect.flip));
    expect(error._tag).toBe("InvalidCodeModeSettingError");
  });
});
