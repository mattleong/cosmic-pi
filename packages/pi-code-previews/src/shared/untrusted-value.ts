import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Rec from "effect/Record";

export const HostObjectSchema = Schema.declare(Predicate.isObject);
export type HostObject = typeof HostObjectSchema.Type;

export const hostObject = Fn.flow(
  Schema.decodeUnknownOption(HostObjectSchema),
  Option.getOrUndefined,
);

export function ownField(value: HostObject | undefined, key: string) {
  if (!value || !Rec.has(value, key)) return undefined;
  return value[key];
}

export function ownObject(value: HostObject | undefined, key: string): HostObject | undefined {
  return hostObject(ownField(value, key));
}

export const HostContainerSchema = Schema.declare(Predicate.isObjectOrArray);
export type HostContainer = typeof HostContainerSchema.Type;

export const hostContainer = Fn.flow(
  Schema.decodeUnknownOption(HostContainerSchema),
  Option.getOrUndefined,
);

export const HostValueSchema = Schema.Union([
  HostContainerSchema,
  Schema.String,
  // @effect-diagnostics-next-line schemaNumber:off -- raw host values are classified as they are; non-finite numbers are still numbers here.
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
]);
export type HostValue = typeof HostValueSchema.Type;

export const hostValue = Fn.flow(
  Schema.decodeUnknownOption(HostValueSchema),
  Option.getOrUndefined,
);
