import type * as JsonSchema from "effect/JsonSchema";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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
  if (!reference.startsWith(DEFINITION_REFERENCE_PREFIX)) return undefined;
  const token = reference.slice(DEFINITION_REFERENCE_PREFIX.length);
  if (token.length === 0 || token.includes("/")) return undefined;
  try {
    return decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~");
  } catch {
    return undefined;
  }
};

const checkReferences = (
  node: JsonSchema.JsonSchema | ReadonlyArray<unknown>,
  path: string,
  definitions: JsonSchema.Definitions,
): void => {
  for (const [key, value] of Object.entries(node)) {
    const at = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (key === "$ref" && Predicate.isString(value)) {
      const name = definitionName(value);
      if (name === undefined || !Object.hasOwn(definitions, name)) {
        throw new ToolOutputSchemaError({
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
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  checkReferences(root, "", document.definitions);
  return freezeSnapshot(root);
};
