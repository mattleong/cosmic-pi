import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";

const ProbedFieldsRecord = Schema.Record(Schema.String, Schema.Unknown);
export type ProbedFields = typeof ProbedFieldsRecord.Type;

const ProbedListArray = Schema.Array(Schema.Unknown);
export type ProbedList = typeof ProbedListArray.Type;

export const probeFields = decodeUnknownOrUndefined(
  Schema.declare((input): input is ProbedFields => Predicate.isObject(input)),
);

export const probeList = decodeUnknownOrUndefined(
  Schema.declare((input): input is ProbedList => Array.isArray(input)),
);

export type OwnDataProperty =
  | { readonly valid: true; readonly present: false }
  | { readonly valid: true; readonly present: true; readonly value: unknown }
  | { readonly valid: false };

export const ownDataProperty = (holder: ProbedFields | ProbedList, key: string): OwnDataProperty =>
  invokeHostCallback(
    (): OwnDataProperty => {
      const descriptor = Object.getOwnPropertyDescriptor(holder, key);
      if (!descriptor) return { valid: true, present: false };
      return "value" in descriptor
        ? { valid: true, present: true, value: descriptor.value }
        : { valid: false };
    },
    { valid: false },
  );

export type OwnTypedProperty<Value> =
  | { readonly valid: true; readonly present: false }
  | { readonly valid: true; readonly present: true; readonly value: Value }
  | { readonly valid: false };

export const ownTypedProperty = <Holder extends object, Key extends keyof Holder & string>(
  holder: Holder,
  key: Key,
): OwnTypedProperty<Holder[Key]> =>
  invokeHostCallback(
    (): OwnTypedProperty<Holder[Key]> => {
      const descriptor = Object.getOwnPropertyDescriptor(holder, key);
      if (!descriptor) return { valid: true, present: false };
      return "value" in descriptor
        ? { valid: true, present: true, value: holder[key] }
        : { valid: false };
    },
    { valid: false },
  );

export const ownKeysAre = (record: ProbedFields, allowed: ReadonlySet<string>): boolean =>
  invokeHostCallback(() => Object.keys(record).every((key) => allowed.has(key)), false);

export const denseElements = (list: ProbedList, maxLength: number): ProbedList | undefined =>
  invokeHostCallback(() => {
    if (Object.getPrototypeOf(list) !== Array.prototype) return undefined;
    const length = ownDataProperty(list, "length");
    if (
      !length.valid ||
      !length.present ||
      !Predicate.isNumber(length.value) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > maxLength ||
      Reflect.ownKeys(list).length !== length.value + 1
    )
      return undefined;
    const elements: Array<ProbedList[number]> = [];
    for (let index = 0; index < length.value; index += 1) {
      const element = ownDataProperty(list, String(index));
      if (!element.valid || !element.present) return undefined;
      elements.push(element.value);
    }
    return elements;
  }, undefined);
