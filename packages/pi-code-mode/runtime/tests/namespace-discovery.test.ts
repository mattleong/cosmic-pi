import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Namespace, Tool } from "../src/index.js";

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
