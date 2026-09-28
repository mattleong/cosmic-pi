import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Namespace, Tool } from "../src/index.js";

const encodeResult = Schema.encodeSync(Schema.fromJsonString(CodeMode.Result));

const tool = () =>
  Tool.make({
    description: "Read",
    input: Schema.Struct({}),
    output: Schema.String,
    run: () => Effect.succeed("ok"),
  });

describe("namespace metadata", () => {
  it.live("searches ancestor descriptions without exposing metadata as guest properties", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({
        tools: {
          "a.b": Namespace.make({
            description: "Astronomy",
            tools: {
              nested: Namespace.make({ description: "Galaxies", tools: { "read-it": tool() } }),
            },
          }),
          plain: { read: tool() },
        },
        discovery: { catalogBudget: 0 },
      });
      for (const query of ["Astronomy", "Galaxies"]) {
        const encodedQuery = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
          query,
        );
        const result = yield* runtime.execute(
          `return await tools.$codemode.search({query:${encodedQuery}})`,
        );
        expect(result.ok && result.value).toMatchObject({
          items: [{ path: 'tools["a.b"].nested["read-it"]' }],
        });
      }
      const result = yield* runtime.execute(
        'return [Object.keys(tools["a.b"]), Object.keys(tools["a.b"].nested), await tools["a.b"].nested["read-it"]({}), await tools.plain.read({})]',
      );
      expect(result.ok && result.value).toEqual([["nested"], ["read-it"], "ok", "ok"]);
      const exact = yield* runtime.execute(
        'return await tools.$codemode.search({query:"tools.plain.read"})',
      );
      expect(exact.ok && exact.value).toMatchObject({
        items: [{ path: "tools.plain.read" }],
        remaining: 0,
      });
    }),
  );

  it("retains fair signature budgets and never emits unbounded namespace prose", () => {
    const tools = { alpha: { one: tool(), two: tool() }, beta: { one: tool(), two: tool() } };
    const cost = Math.round(
      `  - ${CodeMode.make({ tools }).catalog()[0]!.signature} // Read`.length / 4,
    );
    const plain = CodeMode.make({ tools, discovery: { catalogBudget: cost * 2 } });
    const described = CodeMode.make({
      tools: {
        alpha: Namespace.make({ tools: tools.alpha, description: "hidden".repeat(10000) }),
        beta: Namespace.make({ tools: tools.beta, description: "hidden".repeat(10000) }),
        empty: Namespace.make({ tools: {}, description: "empty" }),
      },
      discovery: { catalogBudget: cost * 2 },
    });
    expect(described.snapshot().entries).toEqual(plain.snapshot().entries);
    expect(described.instructions()).not.toContain("hidden");
    expect(JSON.stringify(described.snapshot())).not.toContain("hidden");
    expect(described.snapshot().namespaces).toContainEqual({ name: "empty", total: 0 });
    expect(
      described
        .catalog()
        .every((entry) => Object.keys(entry).sort().join() === "description,path,signature"),
    ).toBe(true);
  });

  it("replaces disclosed metadata and empty topology changes, not ordering or hidden tails", () => {
    const make = (description: string, reverse = false, catalogBudget = 2000) =>
      CodeMode.make({
        tools: {
          api: Namespace.make({
            description,
            tools: reverse ? { b: tool(), a: tool() } : { a: tool(), b: tool() },
          }),
        },
        discovery: { catalogBudget },
      });
    expect(make("same", true).update(make("same").snapshot()).kind).toBe("unchanged");
    expect(make("changed").update(make("same").snapshot()).kind).toBe("replace");
    expect(make("changed", false, 0).update(make("same", false, 0).snapshot()).kind).toBe(
      "unchanged",
    );
    expect(
      make("x".repeat(200) + "new").update(make("x".repeat(200) + "old").snapshot()).kind,
    ).toBe("unchanged");
    const before = CodeMode.make({ tools: { api: { read: tool() } } });
    const after = CodeMode.make({ tools: { api: { read: tool(), empty: {} } } });
    expect(after.update(before.snapshot()).kind).toBe("replace");
  });
});

describe("tool tree validation", () => {
  it("rejects trees that cannot be addressed unambiguously", () => {
    const cyclic = { read: tool(), self: {} };
    cyclic.self = cyclic;
    const invalid: ReadonlyArray<object> = [
      { ns: null },
      { ns: "abc" },
      { ns: [tool()] },
      { ns: cyclic },
      { constructor: tool() },
      { "": tool() },
      { "a.b": tool(), a: { b: tool() } },
      { ["x".repeat(129)]: tool() },
      { ns: Object.assign(Object.create({ inherited: true }), { read: tool() }) },
    ];
    for (const tools of invalid) {
      // SAFETY: Each tree is deliberately malformed to exercise host validation.
      expect(() => CodeMode.make({ tools: tools as never })).toThrow();
    }
    expect(() => CodeMode.make({ tools: { "a.b": tool(), a: { c: tool() } } })).not.toThrow();
  });

  it.live("refuses guest tool paths past the registered depth and name limits", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({
        tools: { ns: { read: tool() } },
        limits: { maxOutputBytes: 2_000 },
      });
      for (const code of [
        "let r = tools; for (let i = 0; i < 20; i++) r = r.ns; return typeof r;",
        'const seg = "a".repeat(1_000_000); let r = tools; for (let i = 0; i < 10; i++) r = r[seg]; return await r({});',
      ]) {
        const result = yield* runtime.execute(code);
        expect(result).toMatchObject({ ok: false, error: { kind: "UnknownTool" } });
        expect(encodeResult(result).length).toBeLessThan(2_000);
      }
    }),
  );
});

describe("search bounds", () => {
  it.live("refuses oversized queries and filters nested namespaces by path prefix", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({
        tools: { mcp: { github: { issues: tool() }, linear: { issues: tool() } } },
      });
      expect(
        yield* runtime.execute(
          'return await tools.$codemode.search({ query: "z ".repeat(2_000_000) })',
        ),
      ).toMatchObject({ ok: false, error: { kind: "InvalidToolInput" } });
      expect(
        yield* runtime.execute(
          'return (await tools.$codemode.search({ query: "issues", namespace: "mcp.github" })).items.map((item) => item.path)',
        ),
      ).toMatchObject({ ok: true, value: ["tools.mcp.github.issues"] });
      expect(
        yield* runtime.execute(
          'return (await tools.$codemode.search({ query: "issues", namespace: "mcp" })).items.length',
        ),
      ).toMatchObject({ ok: true, value: 2 });
    }),
  );
});

describe("tool references", () => {
  it.live("typeof, in, and identity describe the tool tree like an object of functions", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({ tools: { ns: { read: tool() } } });
      expect(
        yield* runtime.execute(`return [typeof tools, typeof tools.ns, typeof tools.ns.read,
          typeof tools.nope, typeof tools.ns.nope, "ns" in tools, "nope" in tools,
          "read" in tools.ns, tools.ns.read === tools.ns.read];`),
      ).toMatchObject({
        ok: true,
        value: ["object", "object", "function", "undefined", "undefined", true, false, true, true],
      });
    }),
  );
});
