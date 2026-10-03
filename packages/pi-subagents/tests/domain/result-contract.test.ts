import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  canonicalResultJson,
  compileResultContract,
  decodeResultText,
  resultValueSchema,
  type ResultContract,
} from "../../src/domain/result-contract.ts";

const compile = (schema: Schema.Json): ResultContract =>
  Effect.runSync(compileResultContract(schema));
const compileError = (schema: Schema.Json): string => {
  const result = Effect.runSync(Effect.result(compileResultContract(schema)));
  if (result._tag === "Success") throw new Error("Expected the schema to be rejected");
  return result.failure.message;
};
const decode = (contract: ResultContract, value: Schema.Json) =>
  Effect.runSync(Effect.result(contract.decode(value)));
const decodeText = (contract: ResultContract, text: string) =>
  Effect.runSync(Effect.result(decodeResultText(contract, text)));

const FINDINGS = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ok", "bad"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "integer" } },
        required: ["file"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "findings"],
  additionalProperties: false,
} satisfies Schema.Json;

const closed = (properties: Record<string, Schema.Json>) =>
  ({ type: "object", properties, additionalProperties: false }) satisfies Schema.Json;

describe("result contracts", () => {
  it("validates object results and rejects excess or mistyped fields", () => {
    const contract = compile(FINDINGS);
    expect(contract.wrapped).toBe(false);
    expect(contract.strictSafe).toBe(true);
    const ok = { verdict: "ok", findings: [{ file: "a.ts", line: 3 }] };
    expect(decode(contract, ok)).toMatchObject({ _tag: "Success", success: ok });
    expect(decode(contract, { verdict: "maybe", findings: [] })._tag).toBe("Failure");
    expect(decode(contract, { ...ok, extra: 1 })._tag).toBe("Failure");
    expect(decode(contract, { verdict: "ok", findings: [{ line: 1 }] })._tag).toBe("Failure");
  });

  it("wraps non-object roots for the tool and unwraps the value", () => {
    const contract = compile({ type: "array", items: { type: "string" } });
    expect(contract.wrapped).toBe(true);
    expect(contract.parameters).toMatchObject({ type: "object", required: ["value"] });
    expect(decode(contract, { value: ["a", "b"] })).toMatchObject({ success: ["a", "b"] });
    expect(decode(contract, { value: [1] })._tag).toBe("Failure");
    expect(decode(contract, ["a"])._tag).toBe("Failure");
  });

  it("marks schemas with non-structural keywords as unsafe for strict sampling", () => {
    expect(compile(closed({ n: { type: "integer", minimum: 0 } })).strictSafe).toBe(false);
    expect(compile(closed({ minimum: { type: "string" } })).strictSafe).toBe(true);
    expect(compile(closed({ code: { type: "string", pattern: "^[A-Z]+$" } })).strictSafe).toBe(
      false,
    );
  });

  it("uses strict sampling only when it cannot change what the schema accepts", () => {
    // Strict conversion closes every object, so an open one could only be sampled as `{}`.
    const unsafe: ReadonlyArray<Schema.Json> = [
      { type: "object" },
      { type: "object", properties: { a: { type: "string" } } },
      closed({ data: { type: "object" } }),
      closed({ findings: { type: "array", items: { type: "object" } } }),
      closed({ tags: { type: "object", additionalProperties: { type: "string" } } }),
      { type: "array" },
      closed({ tags: { type: "array" } }),
      {},
      { description: "anything" },
      closed({ value: {} }),
      closed({ value: { description: "anything" } }),
      closed({ either: { type: ["string", "null"] } }),
      closed({ flag: true }),
    ];
    for (const schema of unsafe)
      expect(compile(schema).strictSafe, JSON.stringify(schema)).toBe(false);
    expect(compile(FINDINGS).strictSafe).toBe(true);
    expect(compile({ type: "array", items: { type: "string" } }).strictSafe).toBe(true);
    expect(compile({ enum: ["ok", "bad"] }).strictSafe).toBe(true);
    expect(compile(closed({ kind: { const: "report" }, at: { type: "null" } })).strictSafe).toBe(
      true,
    );
  });

  it("keeps patterns in the tool schema but never evaluates them in the root", () => {
    const schema = closed({ code: { type: "string", pattern: "^[A-Z]+$" } });
    const contract = compile(schema);
    // The schema the child validates and CLI agents read still carries the pattern.
    expect(contract.parameters).toEqual(schema);
    expect(resultValueSchema(contract)).toEqual(schema);
    expect(decode(contract, { code: "not upper case" })).toMatchObject({ _tag: "Success" });
    expect(decode(contract, { code: 1 })._tag).toBe("Failure");
  });

  it("validates oneOf as anyOf, since skipped keywords can make its branches overlap", () => {
    const patterned = compile({
      oneOf: [
        { type: "string", pattern: "^a" },
        { type: "string", pattern: "^b" },
      ],
    });
    expect(decode(patterned, { value: "abc" })).toMatchObject({ success: "abc" });
    expect(decode(patterned, { value: 1 })._tag).toBe("Failure");
    // Pi's child enforces formats, so each address matches exactly one branch there.
    const contact = compile({
      type: "object",
      properties: {
        contact: {
          oneOf: [
            { type: "string", format: "email" },
            { type: "string", format: "uri" },
          ],
        },
      },
      required: ["contact"],
    });
    for (const address of ["dev@example.com", "https://example.com"])
      expect(decode(contact, { contact: address })).toMatchObject({
        success: { contact: address },
      });
    expect(decode(contact, { contact: 1 })._tag).toBe("Failure");
    const overlapping = compile({ oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] });
    expect(decode(overlapping, { value: "abc" })).toMatchObject({ success: "abc" });
    const alongsideAnyOf = compile({
      anyOf: [{ type: "string" }, { type: "integer" }],
      oneOf: [
        { type: "string", format: "date" },
        { type: "string", format: "date-time" },
        { type: "integer" },
      ],
    });
    expect(decode(alongsideAnyOf, { value: "2026-10-03" })).toMatchObject({
      success: "2026-10-03",
    });
    expect(decode(alongsideAnyOf, { value: true })._tag).toBe("Failure");
  });

  it("rejects patterns that do not compile in Unicode mode, as Pi's tool validation requires", () => {
    const invalid = ["^[\\w-.]+$", "^\\d{4}\\-\\d{2}$", "[unterminated"];
    const placements = (pattern: string): ReadonlyArray<Schema.Json> => [
      closed({ code: { type: "string", pattern } }),
      { type: "string", pattern },
      { type: "object", properties: {}, patternProperties: { [pattern]: { type: "string" } } },
      closed({ tags: { type: "object", propertyNames: { pattern } } }),
      closed({ pair: { type: "array", items: [{ type: "string", pattern }] } }),
      closed({ rest: { type: "array", additionalItems: { type: "string", pattern } } }),
      { type: "object", properties: {}, dependencies: { a: closed({ b: { pattern } }) } },
    ];
    for (const pattern of invalid)
      for (const schema of placements(pattern))
        expect(compileError(schema), JSON.stringify(schema)).toContain(pattern);
    expect(compileError(closed({ code: { type: "string", pattern: 1 } }))).toContain("string");
    // Unicode-only syntax and correctly escaped classes still compile.
    for (const pattern of ["^\\p{Lu}+$", "^[\\w.-]+$", "^\\d{4}-\\d{2}$"])
      expect(compile(closed({ code: { type: "string", pattern } })).parameters).toEqual(
        closed({ code: { type: "string", pattern } }),
      );
  });

  it("accepts integral numbers of any magnitude for integer schemas", () => {
    const schema = closed({ startedAtNs: { type: "integer" } });
    const contract = compile(schema);
    // The child still sees `integer`, and strict sampling is unaffected.
    expect(contract.parameters).toEqual(schema);
    expect(contract.strictSafe).toBe(true);
    for (const startedAtNs of [1_759_480_000_000_000_000, -1e20, 0, 42])
      expect(decode(contract, { startedAtNs })).toMatchObject({ success: { startedAtNs } });
    expect(decode(contract, { startedAtNs: 1.5 })._tag).toBe("Failure");
    expect(decode(contract, { startedAtNs: "1" })._tag).toBe("Failure");
    const nullable = compile({ type: ["integer", "null"] });
    expect(decode(nullable, { value: 2 ** 60 })).toMatchObject({ success: 2 ** 60 });
    expect(decode(nullable, { value: null })).toMatchObject({ success: null });
    expect(decode(nullable, { value: 0.5 })._tag).toBe("Failure");
    const numeric = compile({ type: ["integer", "number"] });
    expect(decode(numeric, { value: 0.5 })).toMatchObject({ success: 0.5 });
    const halves = compile({ type: "integer", multipleOf: 0.5, minimum: 0 });
    expect(decode(halves, { value: 3e18 })).toMatchObject({ success: 3e18 });
    expect(decode(halves, { value: 1.5 })._tag).toBe("Failure");
    expect(decode(halves, { value: -2 })._tag).toBe("Failure");
    const triples = compile({ type: "integer", multipleOf: 3 });
    expect(decode(triples, { value: 3e18 })).toMatchObject({ success: 3e18 });
    expect(decode(triples, { value: 4 })._tag).toBe("Failure");
  });

  it("rejects references, oversized and over-nested schemas, and unsupported keywords", () => {
    expect(compileError({ $defs: { a: { type: "string" } }, $ref: "#/$defs/a" })).toContain(
      "$defs",
    );
    expect(compileError("not an object")).toContain("JSON Schema object");
    expect(compileError({ type: "string", description: "x".repeat(20_000) })).toContain(
      "characters",
    );
    let deep: Schema.Json = { type: "string" };
    for (let index = 0; index < 20; index++) deep = { type: "array", items: deep };
    expect(compileError(deep)).toContain("levels");
    expect(
      compileError({ type: "object", properties: {}, dependentRequired: { a: ["b"] } }),
    ).toContain("Unsupported");
  });

  it("reads results written as text, from bare JSON or the last valid fenced block", () => {
    const contract = compile(FINDINGS);
    const ok = { verdict: "ok", findings: [] };
    expect(decodeText(contract, ` ${JSON.stringify(ok)}\n`)).toMatchObject({ success: ok });
    const fenced = `Draft:\n\`\`\`json\n{"verdict":"bad"}\n\`\`\`\nFinal:\n\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``;
    expect(decodeText(contract, fenced)).toMatchObject({ success: ok });
    expect(decodeText(contract, "The verdict is ok.")._tag).toBe("Failure");
    const mismatch = decodeText(contract, '{"verdict":"maybe","findings":[]}');
    expect(mismatch._tag === "Failure" && mismatch.failure.message).toContain("verdict");
  });

  it("accepts a wrapped result as its value or as its tool arguments", () => {
    const labels = { type: "array", items: { type: "string" } } satisfies Schema.Json;
    const contract = compile(labels);
    expect(resultValueSchema(contract)).toEqual(labels);
    expect(resultValueSchema(compile(FINDINGS))).toEqual(FINDINGS);
    expect(decodeText(contract, '["a"]')).toMatchObject({ success: ["a"] });
    expect(decodeText(contract, '{"value":["a"]}')).toMatchObject({ success: ["a"] });
    expect(decodeText(contract, "[1]")._tag).toBe("Failure");
  });

  it("gives identical schemas the same digest", () => {
    expect(compile(FINDINGS).digest).toBe(compile(structuredClone(FINDINGS)).digest);
    expect(compile(FINDINGS).digest).not.toBe(compile({ type: "string" }).digest);
  });

  it("escapes characters that terminal sanitizers would strip", () => {
    const text = canonicalResultJson({ s: "a\u0085b c" });
    expect(text).toBe('{"s":"a\\u0085b\\u2028c"}');
    expect(JSON.parse(text)).toEqual({ s: "a\u0085b c" });
  });
});
