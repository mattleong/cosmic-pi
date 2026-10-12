import * as Predicate from "effect/Predicate";

const prototypeOf = <Value extends object>(value: Value): object | null => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return Predicate.isObjectKeyword(prototype) ? prototype : null;
};

const isPlainRecord = <Value extends object>(value: Value): boolean => {
  const prototype = prototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const memberNames = <Source extends object>(source: Source): ReadonlySet<string> => {
  const names = new Set<string>();
  for (
    let owner: object | null = source;
    owner !== null && owner !== Object.prototype;
    owner = prototypeOf(owner)
  )
    for (const name of Object.getOwnPropertyNames(owner))
      if (name !== "constructor") names.add(name);
  return names;
};

const isCompleteInstance = <Base extends object>(
  defaults: Base,
  overrides: Partial<Base>,
): overrides is Base => [...memberNames(defaults)].every((name) => name in overrides);

export const overlay = <Base extends object>(defaults: Base, overrides: Partial<Base>): Base => {
  if (isPlainRecord(overrides))
    return Object.defineProperties(defaults, Object.getOwnPropertyDescriptors(overrides));
  if (isCompleteInstance(defaults, overrides)) return overrides;
  throw new Error(
    "A class-instance override must provide every member; pass a plain object for a partial override.",
  );
};

export const ignore = (): undefined => undefined;

export const unavailable = (feature: string): Error =>
  new Error(`${feature} is unavailable in this fixture.`);
