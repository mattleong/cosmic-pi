import { describe, expect, it } from "vitest";
import type { SubagentUsage } from "../src/run/model.ts";
import {
  addUsage,
  clipText,
  clipUtf8Text,
  safeTextPrefix,
  sanitizeDiagnosticText,
} from "../src/run/state.ts";

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
    expect(safeTextPrefix(value, 3)).toBe("ab");
    expect(clipText(value, 3)).toBe("ab…");
    const byteClipped = clipUtf8Text(`${"x".repeat(10)}😀tail`, 14);
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

  it("keeps cost unknown until a backend reports a known cost", () => {
    const unknown = usage({ cost: undefined });
    const combinedUnknown = addUsage(unknown, usage({ cost: undefined }));
    expect(combinedUnknown.cost).toBeUndefined();
    expect(combinedUnknown.totalTokens).toBe(4);
    // A known cost joins and never regresses back to unknown.
    const known = addUsage(combinedUnknown, usage({ cost: 0.25 }));
    expect(known.cost).toBe(0.25);
    const retained = addUsage(known, usage({ cost: undefined }));
    expect(retained.cost).toBe(0.25);
    // A backend-reported known zero stays a known zero.
    expect(addUsage(usage({ cost: undefined }), usage({ cost: 0 })).cost).toBe(0);
  });
});
