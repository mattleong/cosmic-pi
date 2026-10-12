import { flow, identity } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";

export const decodeUnknownOrUndefined = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options?: SchemaAST.ParseOptions,
) =>
  flow(
    identity<unknown>,
    Option.liftThrowable(Schema.decodeUnknownOption(schema, options)),
    Option.flatten,
    Option.getOrUndefined,
  );
