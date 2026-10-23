import { describe, expect, it } from "vitest";
import type { SubagentUsage } from "../src/run/model.ts";
import { addUsage, clipUtf8Text, sanitizeDiagnosticText } from "../src/run/state.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const usage = (overrides: Partial<SubagentUsage> = {}): SubagentUsage => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: 0.01,
  ...overrides,
});

describe("subagent usage state", () => {
  it("clips text without producing unpaired UTF-16 surrogates", () => {
    const value = `ab😀cd`;
    const byteClipped = clipUtf8Text(`${Fn.pipe("x", Str.repeat(10))}😀tail`, 14);
    expect(Buffer.byteLength(byteClipped, "utf8")).toBeLessThanOrEqual(14);
    expect(byteClipped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(sanitizeDiagnosticText(value, 3)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("ignores invalid and overflowing usage updates", () => {
    const current = usage();
    expect(addUsage(current, usage({ input: -1 }))).toBe(current);
    expect(addUsage(current, usage({ cost: Number.POSITIVE_INFINITY }))).toBe(current);
    expect(addUsage(usage({ input: Number.MAX_SAFE_INTEGER }), usage({ input: 1 }))).toEqual(
      usage({ input: Number.MAX_SAFE_INTEGER }),
    );
  });
});
