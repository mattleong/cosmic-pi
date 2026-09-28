import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool, toolError } from "../src/index.js";

const echo = Tool.make({
  description: "Echo a path",
  input: Schema.Struct({ path: Schema.String, count: Schema.optionalKey(Schema.Number) }),
  output: Schema.String,
  run: (input) => Effect.succeed(input.path),
});
const refuse = Tool.make({
  description: "Refuse",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => Effect.fail(toolError("Refused")),
});

const factsOf = (code: string, limits: { timeoutMs?: number; maxToolCalls?: number } = {}) =>
  Effect.map(CodeMode.execute({ code, tools: { host: { echo, refuse } }, limits }), (result) =>
    result.ok ? undefined : result.error,
  );

describe("diagnostic facts", () => {
  it.live("records what each failure concerns, so hosts need not read its wording", () =>
    Effect.gen(function* () {
      for (const [code, facts, limits] of [
        ["await tools.host.nope({});", { tool: "host.nope", toolIssue: "unknown" }],
        ["await tools.nope.x({});", { tool: "nope.x", toolIssue: "unknown" }],
        ["await tools.host.echo({}, {});", { tool: "host.echo", toolIssue: "arity" }],
        [
          "await tools.host.echo({});",
          { tool: "host.echo", toolIssue: "schema", field: ["path"], fieldIssue: "missing" },
        ],
        ["await tools.host.refuse({});", { tool: "host.refuse" }],
        ["class A {}", { syntax: "ClassDeclaration" }],
        ["const x = ;", { reason: expect.any(String) }],
        ["return () => 1;", { owner: "Execution result" }],
        [
          "await tools.host.echo({path:'a'}); await tools.host.echo({path:'b'});",
          { limit: 1 },
          { maxToolCalls: 1 },
        ],
        ["while (true) {}", { timeoutMs: 50 }, { timeoutMs: 50 }],
      ] as const) {
        const error = yield* factsOf(code, limits ?? {});
        expect(error?.facts, code).toEqual(facts);
      }
    }),
  );

  it.live("names what an invalid field expected without the rejected value", () =>
    Effect.gen(function* () {
      const error = yield* factsOf("await tools.host.echo({path:'a', count:'SECRET-VALUE'});");
      expect(error?.facts).toMatchObject({
        field: ["count"],
        fieldIssue: "invalid",
        expected: expect.stringMatching(/number/u),
      });
      expect(error?.facts?.expected).not.toContain("SECRET-VALUE");
    }),
  );
});

describe("tool call diagnostics", () => {
  it.live("point at the failing call and suggest the tool a typo meant", () =>
    Effect.gen(function* () {
      const typo = yield* factsOf("const a = 1;\nawait tools.host.ecoh({ path: 'a' });");
      expect(typo).toMatchObject({ kind: "UnknownTool", location: { line: 2 } });
      expect(typo?.suggestions?.[0]).toContain("tools.host.echo");
      const refused = yield* factsOf("\n\nawait tools.host.refuse({});");
      expect(refused).toMatchObject({ kind: "ToolFailure", location: { line: 3 } });
    }),
  );
});
