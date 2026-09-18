import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ts from "typescript-compiler-api";
import { CodeMode, Tool } from "../src/index.js";
import { jsonSchemaToTypeScript } from "../src/tool-schema.js";

const constrained = Tool.make({
  description: "Accept a constrained document",
  input: {
    type: "object",
    required: ["label", "values"],
    minProperties: 2,
    properties: {
      label: { type: "string", minLength: 2, maxLength: 12, pattern: "^[a-z]+$" },
      values: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { type: "number", minimum: 0, exclusiveMaximum: 10, multipleOf: 0.5 },
      },
      mode: { enum: ["read", "write"] },
    },
  },
  output: { type: "integer", maximum: 9, exclusiveMinimum: 0 },
  run: (input) => Effect.succeed(input),
});

describe("schema constraint discovery", () => {
  it.live("keeps constraints at root, field, array item and result positions discoverable", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({
        tools: { api: { constrained } },
        discovery: { catalogBudget: 0 },
      });
      expect(runtime.instructions()).not.toContain("@pattern");
      const result = yield* runtime.execute(
        'return await tools.$codemode.search({query:"tools.api.constrained"})',
      );
      expect(result.ok).toBe(true);
      for (const tag of [
        "@minProperties 2",
        "@minLength 2",
        "@maxLength 12",
        "@pattern",
        "@minItems 1",
        "@maxItems 3",
        "@uniqueItems true",
        "@minimum 0",
        "@exclusiveMaximum 10",
        "@multipleOf 0.5",
        "@maximum 9",
        "@exclusiveMinimum 0",
      ])
        expect(result.ok && result.value).toMatchObject({
          items: [{ path: "tools.api.constrained", signature: expect.stringContaining(tag) }],
        });
      const signature = runtime.catalog()[0]!.signature;
      expect(signature).toContain('mode?: "read" | "write"');
      const source = `declare const f: ${signature.replace(/^.*?\(input:/s, "(input:").replace("): Promise<", ") => Promise<")};`;
      expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
    }),
  );

  it.live("preserves constraint-only allOf branches throughout discovered signatures", () =>
    Effect.gen(function* () {
      const tool = Tool.make({
        description: "Intersect constraints",
        input: {
          allOf: [
            {
              type: "object",
              properties: {
                label: { allOf: [{ type: "string" }, { minLength: 3, pattern: "^x" }] },
                values: {
                  type: "array",
                  items: { allOf: [{ type: "number" }, { minimum: 7 }] },
                },
              },
            },
            { minProperties: 1 },
          ],
        },
        output: { allOf: [{ type: "string" }, { maxLength: 8 }] },
        run: () => Effect.succeed("x"),
      });
      const runtime = CodeMode.make({ tools: { tool } });
      const result = yield* runtime.execute('return await tools.$codemode.search({query:"tool"})');
      expect(result.ok).toBe(true);
      for (const tag of [
        "@minProperties 1",
        "@minLength 3",
        "@pattern",
        "@minimum 7",
        "@maxLength 8",
      ])
        expect(result.ok && result.value).toMatchObject({
          items: [{ path: "tools.tool", signature: expect.stringContaining(tag) }],
        });
      const signature = runtime.catalog()[0]!.signature;
      const source = `declare const f: ${signature.replace(/^.*?\(input:/s, "(input:").replace("): Promise<", ") => Promise<")};`;
      expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
    }),
  );

  it("documents untyped constraints without guessing types or resolving missing references", () => {
    const constraints = { minLength: 3, pattern: "^x*/" };
    const rendered = jsonSchemaToTypeScript(constraints, true);
    expect(rendered).toContain("@minLength 3");
    expect(rendered).toContain("^x* /");
    expect(rendered).toMatch(/unknown$/);
    expect(jsonSchemaToTypeScript({ allOf: [{ type: "string" }, constraints] })).toBe("string");
    expect(
      jsonSchemaToTypeScript(
        { allOf: [{ type: "string" }, { $ref: "#/$defs/missing", ...constraints }], minimum: 1 },
        true,
      ),
    ).toBe("unknown");
  });

  it.live("does not treat render-only JSON Schema as validation", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({ tools: { constrained } });
      const result = yield* runtime.execute('return await tools.constrained({label:"",values:[]})');
      expect(result.ok && result.value).toEqual({ label: "", values: [] });
    }),
  );

  it("neutralizes comments and refuses to guess an unresolved schema", () => {
    const tool = Tool.make({
      description: "Describe",
      input: { type: "string", pattern: "*/\nmalicious" },
      output: { $ref: "https://invalid.example/schema" },
      run: () => Effect.succeed(null),
    });
    const signature = CodeMode.make({ tools: { tool } }).catalog()[0]!.signature;
    expect(signature).toContain("* /");
    expect(signature).toContain("Promise<unknown>");
  });
});
