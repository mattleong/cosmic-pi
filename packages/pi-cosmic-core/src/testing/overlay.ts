import * as Predicate from "effect/Predicate";

const isPlainRecord = <Value extends object>(value: Value): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const delegate = <Owner extends object>(
  descriptor: PropertyDescriptor,
  owner: Owner,
): PropertyDescriptor => {
  const { get, set, value } = descriptor;
  if (get === undefined && set === undefined)
    return {
      configurable: true,
      enumerable: true,
      writable: true,
      value: Predicate.isFunction(value) ? value.bind(owner) : value,
    };
  const forwarded: PropertyDescriptor = { configurable: true, enumerable: true };
  if (get !== undefined) forwarded.get = () => get.call(owner);
  if (set !== undefined) forwarded.set = (next) => set.call(owner, next);
  return forwarded;
};

export const memberDescriptors = <Source extends object>(source: Source): PropertyDescriptorMap => {
  const descriptors: PropertyDescriptorMap = {};
  for (
    let owner: object | null = source;
    owner !== null && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  ) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(owner))) {
      if (key === "constructor" || Object.hasOwn(descriptors, key)) continue;
      descriptors[key] = owner === source ? descriptor : delegate(descriptor, source);
    }
  }
  return descriptors;
};

const isCompleteInstance = <Base extends object>(
  defaults: Base,
  overrides: Partial<Base>,
): overrides is Base =>
  !isPlainRecord(overrides) &&
  Object.keys(memberDescriptors(defaults)).every((key) => key in overrides);

export const overlay = <Base extends object>(defaults: Base, overrides: Partial<Base>): Base =>
  isCompleteInstance(defaults, overrides)
    ? overrides
    : Object.defineProperties(defaults, memberDescriptors(overrides));

export const ignore = (): undefined => undefined;

export const unavailable = (feature: string): Error =>
  new Error(`${feature} is unavailable in this fixture.`);
