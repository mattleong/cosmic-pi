import type * as JsonSchema from "effect/JsonSchema";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { freezeSnapshot } from "../projection.ts";

export class ToolOutputSchemaError extends Schema.TaggedError<
  ToolOutputSchemaError,
  { readonly brand: unique symbol }
>()("ToolOutputSchemaError", {
  path: Schema.String,
  message: Schema.String,
}) {}

const DEFINITION_REFERENCE_PREFIX = "#/$defs/";

const definitionName = (reference: string): string | undefined => {
  if (!Fn.pipe(reference, Str.startsWith(DEFINITION_REFERENCE_PREFIX))) return undefined;
  const token = Fn.pipe(reference, Str.slice(DEFINITION_REFERENCE_PREFIX.length));
  if (token.length === 0 || Fn.pipe(token, Str.includes("/"))) return undefined;
  try {
    return Fn.pipe(decodeURIComponent(token), Str.replaceAll("~1", "/"), Str.replaceAll("~0", "~"));
  } catch {
    return undefined;
  }
};

const checkReferences = (
  node: JsonSchema.JsonSchema | ReadonlyArray<unknown>,
  path: string,
  definitions: JsonSchema.Definitions,
): void => {
  // @effect-diagnostics-next-line preferEffectRecord:off -- node may be an array; Rec.toEntries takes only records
  for (const [key, value] of Object.entries(node)) {
    const at = `${path}/${Fn.pipe(key, Str.replaceAll("~", "~0"), Str.replaceAll("/", "~1"))}`;
    if (key === "$ref" && Predicate.isString(value)) {
      const name = definitionName(value);
      if (name === undefined || !Rec.has(definitions, name)) {
        throw ToolOutputSchemaError.make({
          path: at,
          message: `Output schema reference ${JSON.stringify(value)} is not a local definition.`,
        });
      }
    } else if (Predicate.isObjectOrArray(value)) {
      checkReferences(value, at, definitions);
    }
  }
};

export const toPiToolOutputSchema = (
  schema: Schema.Constraint,
): Readonly<JsonSchema.JsonSchema> => {
  const document = Schema.toJsonSchemaDocument(schema);
  const root: JsonSchema.JsonSchema =
    Rec.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  checkReferences(root, "", document.definitions);
  return freezeSnapshot(root);
};
