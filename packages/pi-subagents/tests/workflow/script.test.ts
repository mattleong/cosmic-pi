import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { parseWorkflowScript } from "../../src/workflow/script.ts";

const parse = (source: string) => Effect.runSync(Effect.result(parseWorkflowScript(source)));

const failure = (source: string): string => {
  const result = parse(source);
  if (result._tag === "Success") throw new Error("Expected the script to be rejected");
  return result.failure.message;
};

describe("workflow script parsing", () => {
  it("extracts a pure-literal meta and keeps every source position", () => {
    const source = [
      "// leading comment",
      "export const meta = {",
      "  name: 'review',",
      '  description: `Review ${"x"}`.length ? "d" : "d",',
      "};",
    ].join("\n");
    expect(failure(source)).toContain("pure literal");

    const valid = [
      "export const meta = {",
      "  name: 'review', description: \"Review changes\", 'whenToUse': `On request`,",
      "  phases: [{ title: 'Find' }, { title: 'Verify', detail: 'adversarial' }],",
      "};",
      "phase('Find');",
      "return meta.name;",
    ].join("\n");
    const result = parse(valid);
    if (result._tag === "Failure") throw new Error(result.failure.message);
    expect(result.success.meta).toEqual({
      name: "review",
      description: "Review changes",
      whenToUse: "On request",
      phases: [{ title: "Find" }, { title: "Verify", detail: "adversarial" }],
    });
    expect(result.success.body.split("\n")).toHaveLength(valid.split("\n").length);
    expect(result.success.body).toContain("       const meta = {");
    expect(result.success.body.indexOf("phase('Find')")).toBe(valid.indexOf("phase('Find')"));
  });

  it("requires the meta declaration to come first", () => {
    expect(failure("const x = 1;\nexport const meta = { name: 'a', description: 'b' };")).toContain(
      "must begin with",
    );
    expect(failure("export let meta = { name: 'a', description: 'b' };")).toContain(
      "must begin with",
    );
    expect(failure("await agent('x')")).toContain("must begin with");
  });

  it("rejects other module syntax, non-literal meta, and unknown meta fields", () => {
    const meta = "export const meta = { name: 'a', description: 'b' };\n";
    expect(failure(`${meta}export const other = 1;`)).toContain("can't import or export");
    expect(failure(`${meta}import x from "y";`)).toContain("can't import or export");
    expect(failure("const n = 'a';\nexport const meta = { name: n, description: 'b' };")).toContain(
      "must begin with",
    );
    expect(failure("export const meta = { name: n, description: 'b' };")).toContain("pure literal");
    expect(failure("export const meta = { ...base, description: 'b' };")).toContain("pure literal");
    expect(
      failure(
        "export const meta = { name: 'a', description: 'b', phases: [{ title: 'p', model: 'x' }] };",
      ),
    ).toContain("Invalid meta");
    expect(failure("export const meta = { name: '', description: 'b' };")).toContain(
      "Invalid meta",
    );
  });

  it("reports syntax errors, including TypeScript annotations, before anything runs", () => {
    expect(
      failure("export const meta = { name: 'a', description: 'b' };\nconst x: string[] = [];"),
    ).toContain("SyntaxError");
    expect(failure("export const meta = { name: 'a', description: 'b' };\nreturn (")).toContain(
      "SyntaxError",
    );
  });

  it("allows top-level await and return in the script body", () => {
    const result = parse(
      "export const meta = { name: 'a', description: 'b' };\nconst r = await agent('x');\nreturn r;",
    );
    expect(result._tag).toBe("Success");
  });
});
