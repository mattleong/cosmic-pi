import { describe, expect, it } from "@effect/vitest";
import { captureResult } from "../../src/results/serialize.ts";
import { RESULT_MAX_BYTES, RESULT_MAX_VISITS } from "../../src/results/model.ts";
import { formatCodeModeFailure, formatCodeModeSuccess } from "../../src/tools/format.ts";

describe("bounded result capture", () => {
  it("preserves exact strings, compact JSON and log framing", () => {
    for (const value of ["  text\n", "", { a: "😀\n", b: [true, null, 4] }]) {
      const result = { ok: true as const, value, logs: ["log one", " log two "] };
      expect(captureResult(result)).toEqual({
        status: "captured",
        text: formatCodeModeSuccess(result),
      });
    }
    const failed = {
      ok: false as const,
      error: {
        kind: "ExecutionFailure",
        message: "oops",
        location: { line: 2, column: 3 },
        suggestions: ["hint"],
      },
      logs: ["before"],
    };
    expect(captureResult(failed)).toEqual({
      status: "captured",
      text: formatCodeModeFailure(failed),
    });
  });
  it("never invokes array or object getters while capturing", () => {
    let invoked = false;
    const getter = () => {
      invoked = true;
      return "secret";
    };
    const array: string[] = [];
    Object.defineProperty(array, "0", { enumerable: true, get: getter });
    const object = Object.defineProperty({}, "field", { enumerable: true, get: getter });
    for (const value of [array, object])
      expect(captureResult({ ok: true, value }).status).toBe("unavailable");
    expect(invoked).toBe(false);
  });
  it("refuses aggregate bytes and traversal amplification without retaining a graph", () => {
    const text = "x".repeat(RESULT_MAX_BYTES);
    expect(captureResult({ ok: true, value: text }).status).toBe("captured");
    expect(captureResult({ ok: true, value: [text, text] })).toEqual({
      status: "unavailable",
      reason: "capture-limit",
    });
    expect(
      captureResult({ ok: true, value: Array.from({ length: RESULT_MAX_VISITS }, () => null) })
        .status,
    ).toBe("unavailable");
  });
});
