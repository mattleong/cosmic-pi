import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { requiredCases, runCase, validateCases } from "./test262/runner.js";

// Pure inventory tests use deterministic bytes; the mandatory suite verifies the real files.
const cases = requiredCases.map(([file, upstream, asyncTest]) => ({
  file,
  upstream,
  asyncTest,
  source: file,
  sha256: createHash("sha256").update(file).digest("hex"),
}));
const manifest = {
  repository: "https://github.com/tc39/test262",
  commit: "250f204f23a9249ff204be2baec29600faae7b75",
  cases,
} as const;
const sources = new Map<string, string>(cases.map((entry) => [entry.file, entry.source]));

describe("Test262 inventory validation", () => {
  it("accepts a complete inventory with matching bytes", () => {
    expect(validateCases(manifest, sources)).toEqual(cases);
  });

  it("rejects absent and changed fixture bytes without changing repository files", () => {
    const missing = new Map(sources);
    missing.delete("fixtures/tdz.js");
    expect(() => validateCases(manifest, missing)).toThrow("Missing Test262 fixture");
    const changed = new Map(sources);
    changed.set("fixtures/tdz.js", "changed");
    expect(() => validateCases(manifest, changed)).toThrow("checksum mismatch");
  });

  it("rejects empty and reduced inventories", () => {
    expect(() => validateCases({ ...manifest, cases: [] }, sources)).toThrow("must not be empty");
    expect(() => validateCases({ ...manifest, cases: cases.slice(0, 1) }, sources)).toThrow(
      "Missing required Test262 case",
    );
  });

  it("rejects incorrect upstream paths, async flags and duplicates", () => {
    for (const change of [{ upstream: "test/wrong.js" }, { asyncTest: true }]) {
      const modified = cases.map((entry, index) => (index === 0 ? { ...entry, ...change } : entry));
      expect(() => validateCases({ ...manifest, cases: modified }, sources)).toThrow(
        "metadata mismatch",
      );
    }
    expect(() => validateCases({ ...manifest, cases: [...cases, ...cases] }, sources)).toThrow(
      "duplicate Test262 fixture",
    );
  });
});

describe("guest Test262 assertions", () => {
  const scenarios = [
    {
      name: "accepts exact exception types",
      source: "assert.throws(TypeError, () => { throw new TypeError('x'); });",
      asyncTest: false,
      ok: true,
    },
    {
      name: "rejects a subtype instead of Error",
      source: "assert.throws(Error, () => { throw new TypeError('x'); });",
      asyncTest: false,
      ok: false,
    },
    {
      name: "rejects a forged error name",
      source: "assert.throws(TypeError, () => { throw { name: 'TypeError' }; });",
      asyncTest: false,
      ok: false,
    },
    {
      name: "requires an exception",
      source: "assert.throws(Error, () => {});",
      asyncTest: false,
      ok: false,
    },
    {
      name: "accepts delayed completion",
      source: "Promise.resolve().then(() => $DONE());",
      asyncTest: true,
      ok: true,
    },
    { name: "rejects missing completion", source: "", asyncTest: true, ok: false },
    {
      name: "rejects failed completion",
      source: "$DONE(new Error('failure'));",
      asyncTest: true,
      ok: false,
    },
    {
      name: "rejects duplicate completion during final drain",
      source: "$DONE(); Promise.resolve().then(() => Promise.resolve()).then(() => $DONE());",
      asyncTest: true,
      ok: false,
    },
  ];
  for (const scenario of scenarios) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        const result = yield* runCase(scenario);
        expect(result).toMatchObject({ ok: scenario.ok });
      }),
    );
  }
});
