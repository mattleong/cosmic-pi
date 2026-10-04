// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { compileResultContract } from "../../src/domain/result-contract.ts";
import {
  compileWorkflowArgs,
  WORKFLOW_ARGS_SUMMARY_MAX_CHARS,
  workflowArgsSummary,
} from "../../src/workflow/args.ts";
import {
  finished,
  resultValue,
  script,
  testHost,
  withWorkflows,
  workflowFixture,
} from "./fixtures/workflow-harness.ts";

const TARGET = {
  type: "object",
  properties: { target: { type: "string" }, depth: { type: "integer", minimum: 0 } },
  required: ["target"],
  additionalProperties: false,
} satisfies Schema.Json;

/** A complete script whose meta declares {@link TARGET} as its args schema. */
const targeted = (body: string, name = "targeted"): string =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "Takes a target", phases: [{ title: "Main" }], args: ${JSON.stringify(TARGET)} };\n${body}`;

const problemsOf = (schema: Schema.Json, args: Schema.Json) =>
  compileWorkflowArgs(schema).pipe(Effect.flatMap((contract) => contract.check(args)));

describe("workflow args schemas", () => {
  it.effect("accepts matching args and names each mismatching path with what it expected", () =>
    Effect.gen(function* () {
      expect(yield* problemsOf(TARGET, { target: "src", depth: 2 })).toEqual([]);
      const problems = yield* problemsOf(TARGET, { target: 1, depth: 1.5, extra: true });
      const byPath = new Map(problems.map((entry) => [entry.path, entry.problem]));
      expect([...byPath.keys()].toSorted()).toEqual(["args.depth", "args.extra", "args.target"]);
      expect(byPath.get("args.target")).toContain("string");
      expect(byPath.get("args.depth")).toContain("integer");
      expect((yield* problemsOf(TARGET, {})).map((entry) => entry.path)).toEqual(["args.target"]);
    }),
  );

  it.effect("names an integer where the schema declares one, whatever the wrong value is", () =>
    Effect.gen(function* () {
      const schema = {
        type: "object",
        properties: {
          depth: { type: "integer" },
          nested: { type: "object", properties: { count: { type: ["integer", "null"] } } },
          ratio: { type: "number" },
        },
      };
      const problems = yield* problemsOf(schema, {
        depth: "x",
        nested: { count: "y" },
        ratio: "z",
      });
      const byPath = new Map(problems.map((entry) => [entry.path, entry.problem]));
      expect(byPath.get("args.depth")).toContain("integer");
      expect(byPath.get("args.nested.count")).toContain("integer");
      expect(byPath.get("args.ratio")).not.toContain("integer");
    }),
  );

  it.effect("refuses omitted args, which are null, when the schema wants an object", () =>
    Effect.gen(function* () {
      const [problem, ...rest] = yield* problemsOf(TARGET, null);
      expect(rest).toEqual([]);
      expect(problem?.path).toBe("args");
      expect(problem?.problem).toContain("object");
    }),
  );

  it.effect("checks args of any root, as written rather than wrapped", () =>
    Effect.gen(function* () {
      const text = { type: "string", minLength: 1 };
      expect(yield* problemsOf(text, "src")).toEqual([]);
      expect((yield* problemsOf(text, 3)).map((entry) => entry.path)).toEqual(["args"]);
      const files = {
        type: "array",
        items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      };
      expect(yield* problemsOf(files, [{ path: "a.ts" }])).toEqual([]);
      expect(
        (yield* problemsOf(files, [{ path: "a.ts" }, { path: 2 }])).map((entry) => entry.path),
      ).toEqual(["args[1].path"]);
      const spaced = { type: "object", properties: { "a b": { type: "string" } } };
      expect((yield* problemsOf(spaced, { "a b": 1 })).map((entry) => entry.path)).toEqual([
        'args["a b"]',
      ]);
    }),
  );

  it.effect("rejects schemas outside the subset agent() schemas accept", () =>
    Effect.gen(function* () {
      const invalid: ReadonlyArray<Schema.Json> = [
        { $defs: { a: { type: "string" } }, $ref: "#/$defs/a" },
        "string",
        { type: "string", pattern: "[" },
        { not: { type: "string" } },
        { type: "string", description: "x".repeat(20_000) },
      ];
      for (const [index, schema] of invalid.entries()) {
        const error = yield* Effect.flip(compileWorkflowArgs(schema));
        expect(error._tag, `schema ${index}`).toBe("InvalidJsonSchemaError");
      }
    }),
  );

  it.effect("rejects draft-07 forms the root wouldn't check, which result schemas keep", () =>
    Effect.gen(function* () {
      const legacy: ReadonlyArray<Schema.Json> = [
        { type: "object", properties: { pair: { type: "array", items: [{ type: "string" }] } } },
        { type: "array", prefixItems: [{ type: "string" }], additionalItems: false },
        { type: "object", properties: { a: {}, b: {} }, dependencies: { a: ["b"] } },
      ];
      for (const [index, schema] of legacy.entries()) {
        const error = yield* Effect.flip(compileWorkflowArgs(schema));
        expect(error._tag, `schema ${index}`).toBe("InvalidJsonSchemaError");
        // Pi's tool validation enforces these for local agents' results.
        yield* compileResultContract(schema);
      }
      const tuple = { type: "array", prefixItems: [{ type: "string" }], items: false };
      expect(yield* problemsOf(tuple, ["a"])).toEqual([]);
      expect((yield* problemsOf(tuple, [1])).map((entry) => entry.path)).toEqual(["args[0]"]);
    }),
  );

  it("summarizes the schema as the args to pass, within its bound", () => {
    const summary = workflowArgsSummary(TARGET);
    expect(summary).toContain("target: string");
    expect(summary).toContain("depth?: integer");
    expect(workflowArgsSummary({ type: "array", items: { enum: ["fast", "full"] } })).toContain(
      '"fast"',
    );
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [`field${index}`, { type: "string" }]),
      ),
    };
    expect(workflowArgsSummary(wide).length).toBeLessThanOrEqual(WORKFLOW_ARGS_SUMMARY_MAX_CHARS);
  });

  it("summarizes a node's own keys over branches that only refine them", () => {
    const either = workflowArgsSummary({
      type: "object",
      properties: { file: { type: "string" }, dir: { type: "string" } },
      anyOf: [{ required: ["file"] }, { required: ["dir"] }],
    });
    expect(either).toContain("file?: string");
    expect(either).toContain("dir?: string");
    expect(either).not.toContain("any");
    // Required keys the schema doesn't describe are still named.
    expect(workflowArgsSummary({ type: "object", required: ["target"] })).toContain("target");
    // Branches stand in for a node that names only a type.
    const tagged = workflowArgsSummary({
      type: "object",
      oneOf: [
        { properties: { kind: { const: "file" }, path: { type: "string" } } },
        { properties: { kind: { const: "url" }, href: { type: "string" } } },
      ],
    });
    expect(tagged).toContain('"file"');
    expect(tagged).toContain("href");
    // A branch the summary can't show leaves the node's own type.
    expect(workflowArgsSummary({ type: "string", anyOf: [{ minLength: 1 }, { const: "" }] })).toBe(
      "string",
    );
  });
});

describe("workflow args at start", () => {
  it.live(
    "starts with matching args and refuses mismatching or omitted ones before running",
    () => {
      const fixture = workflowFixture();
      return withWorkflows(fixture, (workflows) =>
        Effect.gen(function* () {
          const source = { kind: "inline" as const, script: targeted("return { got: args };") };
          const started = yield* workflows.start({ source, args: { target: "src" } }, testHost());
          expect(resultValue(yield* finished(workflows, started.id))).toEqual({
            got: { target: "src" },
          });

          const mismatch = yield* workflows
            .start({ source, args: { target: 3 } }, testHost())
            .pipe(Effect.flip);
          expect(mismatch).toMatchObject({
            _tag: "WorkflowRequestError",
            code: "args_mismatch",
            argsProblems: [{ path: "args.target" }],
          });
          // The refusal names the path and advertises the args the workflow expects.
          expect(mismatch.message).toContain("args.target");
          expect(mismatch.message).toContain("target: string");

          const omitted = yield* workflows
            .start({ source, args: null }, testHost())
            .pipe(Effect.flip);
          expect(omitted).toMatchObject({
            code: "args_mismatch",
            argsProblems: [{ path: "args" }],
          });

          const resumed = yield* workflows
            .start({ source, args: {}, resumeFromRunId: started.id }, testHost())
            .pipe(Effect.flip);
          expect(resumed).toMatchObject({
            code: "args_mismatch",
            argsProblems: [{ path: "args.target" }],
          });
          expect((yield* workflows.list).map((run) => run.id)).toEqual([started.id]);
        }),
      );
    },
  );

  it.live("accepts any args for a script without meta.args", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        for (const args of [null, "text", [1, 2], { anything: { goes: true } }]) {
          const started = yield* workflows.start(
            { source: { kind: "inline", script: script("return { got: args };") }, args },
            testHost(),
          );
          expect(resultValue(yield* finished(workflows, started.id))).toEqual({ got: args });
        }
      }),
    );
  });

  it.live("fails the run when a nested workflow's args don't match, even inside parallel()", () => {
    const fixture = workflowFixture({
      scripts: { child: targeted("return { got: args.target };", "child") },
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const run = (args: string) =>
          workflows
            .start(
              {
                source: {
                  kind: "inline",
                  script: script(
                    `const [value] = await parallel([() => workflow("child", ${args})]); return value;`,
                  ),
                },
                args: null,
              },
              testHost(),
            )
            .pipe(Effect.flatMap((started) => finished(workflows, started.id)));

        const matching = yield* run('{ target: "src" }');
        expect(matching.state).toBe("completed");
        expect(resultValue(matching)).toEqual({ got: "src" });
        expect(matching.phases.map((phase) => phase.title)).toContain("▸ child · Main");

        const mismatched = yield* run("{ target: 1 }");
        expect(mismatched.state).toBe("failed");
        expect(mismatched.failure?.message).toContain("args.target");
        // Nothing of the refused workflow was added to the run.
        expect(mismatched.phases.map((phase) => phase.title)).toEqual(["Main"]);

        const omitted = yield* run("undefined");
        expect(omitted.state).toBe("failed");

        // A nested workflow that doesn't load is an invalid call too, not a null result.
        const misspelled = yield* workflows
          .start(
            {
              source: {
                kind: "inline",
                script: script(
                  'const [value] = await parallel([() => workflow("chlid", { target: "src" })]); return value;',
                ),
              },
              args: null,
            },
            testHost(),
          )
          .pipe(Effect.flatMap((started) => finished(workflows, started.id)));
        expect(misspelled.state).toBe("failed");
      }),
    );
  });
});
