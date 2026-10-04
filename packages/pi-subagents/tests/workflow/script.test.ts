import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  parseWorkflowScript,
  WORKFLOW_PHASE_AGENT_LIMIT,
  WORKFLOW_SCRIPT_AGENT_LIMIT,
  workflowPlannedAgents,
} from "../../src/workflow/script.ts";

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

  it("keeps the script source exactly as given", () => {
    const source = "export const meta = { name: 'a', description: 'b' };\nreturn 1;\n";
    const result = parse(source);
    if (result._tag === "Failure") throw new Error(result.failure.message);
    expect(result.success.source).toBe(source);
  });
});

describe("args schema in meta", () => {
  const withArgs = (args: string) =>
    `export const meta = { name: 'a', description: 'b', args: ${args} };\nreturn args;`;

  it("compiles a literal args schema of any root when the script is parsed", () => {
    for (const args of [
      "{ type: 'object', properties: { target: { type: 'string' } }, required: ['target'] }",
      "{ type: 'array', items: { type: 'string' } }",
      "{ type: 'string', minLength: 1 }",
    ]) {
      const result = parse(withArgs(args));
      if (result._tag === "Failure") throw new Error(result.failure.message);
      expect(result.success.args?.summary, args).toBeTruthy();
    }
    const plain = parse("export const meta = { name: 'a', description: 'b' };\nreturn args;");
    if (plain._tag === "Failure") throw new Error(plain.failure.message);
    expect(plain.success.args).toBeUndefined();
  });

  it("rejects an unusable args schema as a script error naming meta.args", () => {
    for (const args of [
      "{ $ref: '#/$defs/x' }",
      "'string'",
      "{ type: 'string', pattern: '[' }",
      `{ type: 'string', description: '${"x".repeat(20_000)}' }`,
    ]) {
      const result = parse(withArgs(args));
      expect(result._tag, args.slice(0, 60)).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure._tag).toBe("WorkflowScriptError");
        expect(result.failure.message).toContain("meta.args");
      }
    }
    expect(failure(withArgs("{ type: kind }"))).toContain("pure literal");
  });
});

describe("planned agents in meta", () => {
  const withAgents = (agents: string) =>
    `export const meta = { name: 'a', description: 'b', phases: [{ title: 'Find', agents: ${agents} }, { title: 'Verify' }] };`;

  it("accepts labels and labelled profiles, in declaration order", () => {
    const result = parse(withAgents("['finder', { label: ' checker ', profile: 'reviewer' }]"));
    if (result._tag === "Failure") throw new Error(result.failure.message);
    const [find, verify] = result.success.meta.phases ?? [];
    expect(workflowPlannedAgents(find!)).toEqual([
      { phase: "Find", label: "finder" },
      { phase: "Find", label: "checker", profile: "reviewer" },
    ]);
    expect(workflowPlannedAgents(verify!)).toEqual([]);
    expect(workflowPlannedAgents(find!, "▸ nested · Find")[0]?.phase).toBe("▸ nested · Find");
  });

  it("trims phase titles once, so planned agents use the title phase() calls give", () => {
    const result = parse(
      "export const meta = { name: 'a', description: 'b', phases: [{ title: ' Find  ', agents: ['finder'] }] };",
    );
    if (result._tag === "Failure") throw new Error(result.failure.message);
    const [find] = result.success.meta.phases ?? [];
    expect(find?.title).toBe("Find");
    expect(workflowPlannedAgents(find!)).toEqual([{ phase: "Find", label: "finder" }]);
    expect(
      failure("export const meta = { name: 'a', description: 'b', phases: [{ title: '   ' }] };"),
    ).toContain("title");
  });

  it("rejects malformed entries with the offending path", () => {
    expect(failure(withAgents(`['${"x".repeat(81)}']`))).toContain("agents");
    expect(failure(withAgents("[{ label: '' }]"))).toContain("label");
    expect(failure(withAgents("[{ label: 'a', model: 'x' }]"))).toContain("model");
    expect(failure(withAgents("[3]"))).toContain("Invalid meta");
    expect(failure(withAgents("['   ']"))).toContain("blank");
  });

  it("bounds planned agents per phase and per script", () => {
    const labels = (count: number) =>
      JSON.stringify(Array.from({ length: count }, (_, index) => `agent-${index}`));
    expect(parse(withAgents(labels(WORKFLOW_PHASE_AGENT_LIMIT)))._tag).toBe("Success");
    expect(failure(withAgents(labels(WORKFLOW_PHASE_AGENT_LIMIT + 1)))).toContain("Invalid meta");
    const phases = Array.from(
      { length: WORKFLOW_SCRIPT_AGENT_LIMIT / WORKFLOW_PHASE_AGENT_LIMIT + 1 },
      (_, index) => `{ title: 'P${index}', agents: ${labels(WORKFLOW_PHASE_AGENT_LIMIT)} }`,
    );
    expect(
      failure(
        `export const meta = { name: 'a', description: 'b', phases: [${phases.join(", ")}] };`,
      ),
    ).toContain(String(WORKFLOW_SCRIPT_AGENT_LIMIT));
  });
});
