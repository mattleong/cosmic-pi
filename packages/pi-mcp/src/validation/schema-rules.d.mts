import type * as Schema from "effect/Schema";

/** Throws unless the schema is bounded and inside the helper's JSON Schema policy. */
export declare function assertSchemaDocument(
  schema: Schema.Json,
  options?: { readonly references?: boolean },
): void;
