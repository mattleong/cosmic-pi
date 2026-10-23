import { RuleTester } from "oxlint/plugins-dev";

import { noCallableTypePredicateRule } from "./no-callable-type-predicate.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "callablePredicate" };
const imports = [
  'import * as Predicate from "effect/Predicate";',
  'import * as Schema from "effect/Schema";',
].join("\n");
const code = (source: string) => `${imports}\n${source}`;

tester.run("anti-slop/no-callable-type-predicate", noCallableTypePredicateRule, {
  valid: [
    code(`
const isNamed = (value: unknown): value is { readonly name: string } =>
  Predicate.hasProperty(value, "name") && Predicate.isString(value.name);`),
    code("const Callable = Schema.declare(Predicate.isFunction);"),
    code(`
const isText = (value: unknown): value is string => Predicate.isString(value);
const isRecord = <V>(value: V): value is V & (object | null) =>
  value === null || Predicate.isObjectOrArray(value);`),
    // Callability proves `Function`, and an unclaimed member is only a discriminator.
    code(`
const isAnyFunction = (value: unknown): value is Function => Predicate.isFunction(value);
const isData = (value: unknown): value is { readonly kind: string } =>
  Predicate.hasProperty(value, "kind") &&
  Predicate.isString(value.kind) &&
  !(Predicate.hasProperty(value, "call") && Predicate.isFunction(value.call));`),
    code(`
interface Payload {
  readonly id: string;
  readonly handler: Function;
}
const isPayload = (value: unknown): value is Payload =>
  Predicate.hasProperty(value, "id") &&
  Predicate.hasProperty(value, "handler") &&
  Predicate.isFunction(value.handler);`),
    // A callability check in a nested callback does not support the outer claim.
    code(`
const isList = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value) && value.every((item) => Predicate.isFunction(item));`),
    code(`
const callback = <F>() => Schema.declare<F>((value): value is F => Predicate.isString(value));`),
  ],
  invalid: [
    {
      code: code(`
const isTextCallback = (value: unknown): value is (text: string) => void =>
  Predicate.isFunction(value);`),
      errors: [error],
    },
    {
      code: code(`
type Callback = (state: number) => void;
const isCallback = <V>(value: V): value is V & Callback => Predicate.isFunction(value);`),
      errors: [error],
    },
    {
      code: code(`
const callback = <F>() =>
  Schema.optional(Schema.declare<F>((value): value is F => Predicate.isFunction(value)));`),
      errors: [error],
    },
    {
      code: code(
        "const callback = <F>() => Schema.declare<F>((value) => Predicate.isFunction(value));",
      ),
      errors: [error],
    },
    {
      code: code("const callback = <F>() => Schema.declare<F>(Predicate.isFunction);"),
      errors: [error],
    },
    {
      code: code(`
import type { Responder } from "./protocol.ts";
const isResponder = <V>(value: V): value is V & Responder => Predicate.isFunction(value);`),
      errors: [error],
    },
    {
      code: code(`
interface Relay {
  readonly version: 1;
  readonly ask: (request: string) => Promise<string>;
}
const isRelay = (value: unknown): value is Relay =>
  Predicate.hasProperty(value, "version") &&
  value.version === 1 &&
  Predicate.hasProperty(value, "ask") &&
  Predicate.isFunction(value.ask);`),
      errors: [error],
    },
    {
      code: code(`
function isHandler(value: unknown): value is { handle(input: string): void } {
  if (!Predicate.hasProperty(value, "handle")) return false;
  return typeof value.handle === "function";
}`),
      errors: [error],
    },
    {
      code: code(`
const isFactory = (value: unknown): value is new () => object => value instanceof Function;
const isListener = (value: unknown): value is () => void =>
  Function.prototype.isPrototypeOf(value);`),
      errors: [error, error],
    },
  ],
});
