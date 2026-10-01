import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

/**
 * Tolerant decode of an untrusted value. A schema mismatch, a hostile getter or proxy, and any
 * other decode defect all yield `undefined`; this never throws.
 */
export const decodeUnknownOrUndefined = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
  options?: SchemaAST.ParseOptions,
): S["Type"] | undefined => {
  try {
    const exit = Schema.decodeUnknownExit(schema, options)(value);
    return Exit.isSuccess(exit) ? exit.value : undefined;
  } catch {
    return undefined;
  }
};
