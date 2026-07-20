import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { scanArchitectureSource } from "./check-effect-architecture.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = async (name, ignoredRules = []) => {
  const path = `scripts/fixtures/effect-architecture/${name}.ts`;
  const source = await readFile(resolve(root, path), "utf8");
  return scanArchitectureSource(path, source, {
    applyProductionAllowlists: false,
    ignoredRules,
  });
};

describe("Effect architecture fixtures", () => {
  for (const name of [
    "managed-runtime-facade",
    "typed-expected-error",
    "unrelated-runner-method",
  ]) {
    test(`allows ${name}`, async () => {
      assert.deepEqual(await fixture(`allow/${name}`), []);
    });
  }

  test("allows an exported Layer that hides its raw HTTP dependency", async () => {
    assert.equal(
      (await fixture("allow/hidden-layer-dependency", ["unstableEffectImport"])).some(
        ({ rule }) => rule === "leakedHttpLayer",
      ),
      false,
    );
  });

  for (const [name, rule] of [
    ["detached-run-fork", "effectRunner"],
    ["named-effect-runner", "effectRunner"],
    ["renamed-effect-runner", "effectRunner"],
    ["unsafe-json-body", "bodyJsonUnsafe"],
    ["leaked-layer-dependency", "leakedHttpLayer"],
    ["aliased-leaked-layer-dependency", "leakedHttpLayer"],
    ["reexported-leaked-layer-dependency", "leakedHttpLayer"],
    ["expected-error-throw", "expectedErrorThrow"],
    ["unsafe-scope", "unsafeEffectOperation"],
  ]) {
    test(`rejects ${name}`, async () => {
      assert.equal(
        (await fixture(`deny/${name}`, ["unstableEffectImport"])).some(
          (violation) => violation.rule === rule,
        ),
        true,
      );
    });
  }
});
