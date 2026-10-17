import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { describe, expect, it } from "vitest";
import { toPiToolOutputSchema } from "../src/schema/tool-output.ts";

interface Task {
  readonly id: string;
  readonly status: "done" | "failed";
  readonly children: ReadonlyArray<Task>;
}

const Task: Schema.Codec<Task> = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["done", "failed"]),
  children: Schema.Array(Schema.suspend((): Schema.Codec<Task> => Task)),
}).annotate({ identifier: "Task" });

const Output = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("one"), task: Task }),
  Schema.Struct({ kind: Schema.Literal("many"), tasks: Schema.Array(Task) }),
]);

const standaloneGuard = (json: Readonly<JsonSchema.JsonSchema>) =>
  Schema.is(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(json)));

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
    expect(guard({ kind: "many", tasks: [{ id: "b", status: "running", children: [] }] })).toBe(
      false,
    );
    expect(
      guard({ kind: "one", task: { id: "b", status: "failed", children: [{ id: "c" }] } }),
    ).toBe(false);
    expect(guard({ kind: "other", tasks: [] })).toBe(false);
  });
});
