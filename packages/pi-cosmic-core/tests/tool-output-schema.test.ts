import * as JsonSchema from "effect/JsonSchema";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, it } from "vitest";
import { toPiToolOutputSchema, ToolOutputSchemaError } from "../src/schema/tool-output.ts";
import { thrownInstance } from "./support/thrown.ts";

interface Task {
  readonly id: string;
  readonly status: "done" | "failed";
  readonly children: ReadonlyArray<Task>;
}

/** An identified, recursive definition: the generated schema must reference it, not inline it. */
const Task: Schema.Codec<Task> = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["done", "failed"]),
  children: Schema.Array(Schema.suspend((): Schema.Codec<Task> => Task)),
}).annotate({ identifier: "Task" });

const Output = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("one"), task: Task }),
  Schema.Struct({ kind: Schema.Literal("many"), tasks: Schema.Array(Task) }),
]);

/** Reads the returned JSON Schema back on its own, with no access to Effect's separate definitions. */
const standaloneGuard = (json: Readonly<JsonSchema.JsonSchema>) =>
  Schema.is(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(json)));

/** An output schema whose `note` field compiles to the given reference. */
const withReference = (reference: string) =>
  Schema.Struct({
    task: Task,
    note: Schema.String.check(
      Schema.makeFilter<string>(() => true, { toJsonSchema: () => ({ $ref: reference }) }),
    ),
  });

describe("toPiToolOutputSchema", () => {
  it("returns a self-contained schema whose references resolve within it", () => {
    const json = toPiToolOutputSchema(Output);
    const guard = standaloneGuard(json);
    const leaf: Task = { id: "b", status: "failed", children: [] };
    const encode = Schema.encodeSync(Schema.toCodecJson(Output));

    expect(
      guard(encode({ kind: "one", task: { id: "a", status: "done", children: [leaf] } })),
    ).toBe(true);
    expect(guard(encode({ kind: "many", tasks: [leaf] }))).toBe(true);
    expect(guard({ kind: "many", tasks: [{ ...leaf, status: "running" }] })).toBe(false);
    expect(guard({ kind: "one", task: { ...leaf, children: [{ id: "c" }] } })).toBe(false);
    expect(guard({ kind: "other", tasks: [] })).toBe(false);
  });

  it("rejects references that the returned definitions cannot resolve", () => {
    for (const reference of [
      "https://example.com/task.json",
      "#/$defs/Missing",
      "#",
      "#/$defs/Task/properties/id",
    ]) {
      const error = thrownInstance(ToolOutputSchemaError, () =>
        toPiToolOutputSchema(withReference(reference)),
      );
      expect(error.path.startsWith("/properties/note/")).toBe(true);
      expect(error.path.endsWith("/$ref")).toBe(true);
    }
  });

  it("returns deeply frozen JSON", () => {
    const json = toPiToolOutputSchema(Output);
    const pending: Array<unknown> = [json];
    let objects = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (!Predicate.isObjectOrArray(node)) continue;
      expect(Object.isFrozen(node)).toBe(true);
      objects += 1;
      pending.push(...Object.values(node));
    }

    expect(objects).toBeGreaterThan(1);
    expect(Reflect.set(json, "type", "string")).toBe(false);
  });
});
