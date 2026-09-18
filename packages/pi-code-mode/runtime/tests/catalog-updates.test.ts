import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

const tool = (description = "Read a value") =>
  Tool.make({
    description,
    input: Schema.Struct({}),
    output: Schema.String,
    run: () => Effect.succeed(description),
  });

describe("semantic discovery updates", () => {
  it("canonicalizes insertion order and does not compare implementation identity", () => {
    const before = CodeMode.make({ tools: { z: { b: tool(), a: tool() }, a: { c: tool() } } });
    const after = CodeMode.make({ tools: { a: { c: tool() }, z: { a: tool(), b: tool() } } });
    expect(after.update(before.snapshot())).toEqual({ kind: "unchanged" });
    expect(after.update().kind).toBe("replace");
    expect(Object.isFrozen(after.snapshot().entries[0])).toBe(true);
  });

  it("reports added, changed and removed exact signatures", () => {
    const before = CodeMode.make({
      tools: { api: { keep: tool(), change: tool(), remove: tool() } },
    });
    const after = CodeMode.make({
      tools: { api: { keep: tool(), change: tool("Changed meaning"), "new-tool": tool() } },
    });
    const update = after.update(before.snapshot());
    expect(update.kind).toBe("delta");
    if (update.kind !== "delta") return;
    expect(update.added.map(({ path }) => path)).toEqual(['tools.api["new-tool"]']);
    expect(update.changed.map(({ path }) => path)).toEqual(["tools.api.change"]);
    expect(update.removed).toEqual(["tools.api.remove"]);
    expect(update.changed[0]?.signature).toContain("Promise<string>");
  });

  it("detects signature changes and ignores undisclosed-only changes", () => {
    const before = CodeMode.make({ tools: { api: { read: tool() } } });
    const after = CodeMode.make({
      tools: {
        api: {
          read: Tool.make({
            description: "Read a value",
            input: Schema.Struct({ name: Schema.String }),
            output: Schema.String,
            run: ({ name }) => Effect.succeed(name),
          }),
        },
      },
    });
    const update = after.update(before.snapshot());
    expect(update.kind).toBe("delta");
    if (update.kind === "delta") expect(update.changed[0]?.signature).toContain("name: string");
    const hiddenBefore = CodeMode.make({
      tools: { api: { read: tool() } },
      discovery: { catalogBudget: 0 },
    });
    const hiddenAfter = CodeMode.make({
      tools: { api: { read: tool("different") } },
      discovery: { catalogBudget: 0 },
    });
    expect(hiddenAfter.update(hiddenBefore.snapshot())).toEqual({ kind: "unchanged" });
  });

  it("falls back to bounded replacement for a large removal list", () => {
    const before = CodeMode.make({
      tools: {
        api: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => ["longToolName".repeat(8) + i, tool()]),
        ),
      },
      discovery: { catalogBudget: 100_000 },
    });
    const after = CodeMode.make({ tools: { api: { read: tool() } } });
    expect(after.update(before.snapshot()).kind).toBe("replace");
  });

  it("replaces when namespace meaning or completeness changes", () => {
    const complete = CodeMode.make({ tools: { api: { read: tool() } } });
    const partial = CodeMode.make({
      tools: { api: { read: tool() } },
      discovery: { catalogBudget: 0 },
    });
    expect(partial.snapshot().entries).toEqual([]);
    expect(partial.snapshot().namespaces).toEqual([{ name: "api", total: 1 }]);
    expect(partial.update(complete.snapshot()).kind).toBe("replace");
    expect(
      CodeMode.make({ tools: { api: { read: { child: tool() } } } }).update(complete.snapshot())
        .kind,
    ).toBe("replace");
    expect(
      CodeMode.make({ tools: { other: { read: tool() } } }).update(complete.snapshot()).kind,
    ).toBe("replace");
  });

  it("replaces complete catalogs when only Rules or Language policy changes", () => {
    const runtime = CodeMode.make({ tools: { api: { read: tool() } } });
    for (const heading of ["## Rules", "## Language"]) {
      const previous = {
        ...runtime.snapshot(),
        instructions: runtime.instructions().replace(heading, `${heading}\nOld policy`),
      };
      expect(runtime.update(previous).kind).toBe("replace");
    }
  });

  it.live("preserves literal segments in search and executable signatures", () =>
    Effect.gen(function* () {
      const runtime = CodeMode.make({
        tools: { "a.b": { 'say-"hi': tool("literal") }, a: { b: { c: tool() } } },
      });
      const path = 'tools["a.b"]["say-\\\"hi"]';
      expect(runtime.snapshot().entries.some((entry) => entry.path === path)).toBe(true);
      const found = yield* runtime.execute(
        `return await tools.$codemode.search({query: ${Schema.encodeSync(Schema.fromJsonString(Schema.String))(path)}})`,
      );
      expect(found.ok && found.value).toMatchObject({ items: [{ path }] });
      const called = yield* runtime.execute(`return await ${path}({})`);
      expect(called.ok && called.value).toBe("literal");
    }),
  );

  it.live("retains fair budget selection and complete paginated search", () =>
    Effect.gen(function* () {
      const tools = { alpha: { one: tool(), two: tool() }, beta: { one: tool(), two: tool() } };
      const full = CodeMode.make({ tools });
      const cost = Math.round(`  - ${full.catalog()[0]!.signature} // Read a value`.length / 4);
      const runtime = CodeMode.make({ tools, discovery: { catalogBudget: cost * 2 } });
      expect(runtime.snapshot().entries.map(({ path }) => path)).toEqual([
        "tools.alpha.one",
        "tools.beta.one",
      ]);
      expect(runtime.snapshot().complete).toBe(false);
      const found = yield* runtime.execute(
        'return await tools.$codemode.search({namespace:"alpha",limit:1,offset:1})',
      );
      expect(found.ok && found.value).toMatchObject({
        items: [{ path: "tools.alpha.two" }],
        remaining: 0,
        next: null,
      });
    }),
  );
});
