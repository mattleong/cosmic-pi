import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/** Decodes an unknown value without allocating an Option for a missing result. */
export const decodeUnknownOrUndefined = <S extends Schema.ConstraintDecoder<unknown>, ValueInput>(
  schema: S,
  value: ValueInput,
): S["Type"] | undefined => {
  const exit = Schema.decodeUnknownExit(schema)(value);
  return Exit.isSuccess(exit) ? exit.value : undefined;
};
