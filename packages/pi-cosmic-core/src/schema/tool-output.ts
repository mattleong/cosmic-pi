/**
 * Native Pi `outputSchema` derivation. Effect Schema stays authoritative; Pi receives the generated
 * draft 2020-12 JSON Schema as one self-contained, immutable value.
 */
import type * as JsonSchema from "effect/JsonSchema";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "../projection.ts";

/** A generated output schema contains a reference that its own `$defs` cannot resolve. */
export class ToolOutputSchemaError extends Schema.TaggedError<ToolOutputSchemaError>()(
  "ToolOutputSchemaError",
  {
    /** JSON Pointer to the rejected `$ref`, relative to the returned root schema. */
    path: Schema.String,
    message: Schema.String,
  },
) {}

const DEFINITION_REFERENCE_PREFIX = "#/$defs/";

/** Decodes a direct `#/$defs/<escaped-token>` reference, the one form Effect emits and Pi resolves. */
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

/**
 * Derives a native Pi `ToolDefinition.outputSchema` from an Effect schema.
 *
 * Definitions from `Schema.toJsonSchemaDocument` move under the root `$defs`, so every local
 * reference resolves within the returned value. The schema describes the encoded side of
 * `Schema.toCodecJson(schema)`; encode `structuredContent` with that codec. A remote, root,
 * nested-pointer, or missing reference throws `ToolOutputSchemaError`. The result is deeply frozen.
 */
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
