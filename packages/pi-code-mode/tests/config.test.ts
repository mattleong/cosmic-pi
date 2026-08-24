import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { findCodeModeSettingDescriptor, resolveCodeModeConfig } from "../src/config/options.ts";
import { CODE_MODE_FIELD_IDS, DEFAULT_CODE_MODE_CONFIG } from "../src/config/schema.ts";

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
});

describe("code mode setting descriptors", () => {
  it("parses bounded integers and rejects malformed or out-of-range input", () => {
    const descriptor = findCodeModeSettingDescriptor("timeoutMs");
    expect(descriptor).toBeDefined();
    expect(Result.getOrThrow(descriptor!.decode("60000"))).toBe(60_000);
    expect(Result.getOrThrow(descriptor!.decode(" 250 "))).toBe(250);
    for (const raw of ["nope", "1.5", "1e3", "", "0", "-1", "600001", "99999999999999999999"]) {
      const decoded = descriptor!.decode(raw);
      expect(Result.isFailure(decoded)).toBe(true);
      if (Result.isFailure(decoded)) {
        expect(decoded.failure._tag).toBe("InvalidCodeModeSettingError");
        expect(decoded.failure.message).toContain("timeoutMs");
      }
    }
  });

  it("parses booleans strictly", () => {
    const descriptor = findCodeModeSettingDescriptor("enabled");
    expect(Result.getOrThrow(descriptor!.decode("true"))).toBe(true);
    expect(Result.getOrThrow(descriptor!.decode("false"))).toBe(false);
    const decoded = descriptor!.decode("yes");
    expect(Result.isFailure(decoded)).toBe(true);
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("InvalidCodeModeSettingError");
    }
  });
});
