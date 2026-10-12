import * as Predicate from "effect/Predicate";

const isCompleteInstance = <Base extends object>(
  defaults: Base,
  overrides: Partial<Base>,
): overrides is Base => {
  let owner: unknown = defaults;
  while (Predicate.isObjectKeyword(owner) && owner !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(owner))
      if (name !== "constructor" && !(name in overrides)) return false;
    owner = Object.getPrototypeOf(owner);
  }
  return true;
};

export const overlay = <Base extends object>(defaults: Base, overrides: Partial<Base>): Base => {
  const prototype: unknown = Object.getPrototypeOf(overrides);
  if (prototype === Object.prototype || prototype === null)
    return Object.defineProperties(defaults, Object.getOwnPropertyDescriptors(overrides));
  if (isCompleteInstance(defaults, overrides)) return overrides;
  throw new Error(
    "A class-instance override must provide every member; pass a plain object for a partial override.",
  );
};

export const ignore = (): undefined => undefined;

export const unavailable = (feature: string): Error =>
  new Error(`${feature} is unavailable in this fixture.`);
