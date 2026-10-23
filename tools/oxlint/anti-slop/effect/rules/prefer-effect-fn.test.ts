import { RuleTester } from "oxlint/plugins-dev";

import { preferEffectFnRule } from "./prefer-effect-fn.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "preferEffectFn" };
const effect = 'import * as Effect from "effect/Effect";\n';

tester.run("anti-slop-effect/prefer-effect-fn", preferEffectFnRule, {
  valid: [
    `${effect}const load = Effect.fn("Store.load")(function* (id: string) { return yield* read(id); });`,
    // Inline callbacks passed positionally are not named function boundaries.
    `${effect}Effect.forEach(items, (item) => Effect.gen(function* () { yield* save(item); }));`,
    `${effect}const make = (deps: Deps) => (id: string) => Effect.gen(function* () { return yield* deps.read(id); });`,
    // Work before Effect.gen runs eagerly at call time.
    `${effect}const load = (id: string) => { const key = keyOf(id); return Effect.gen(function* () { return yield* read(key); }); };`,
    // Effect.gen bound to `this` has no Effect.fn equivalent.
    `${effect}class Pool { acquire() { return Effect.gen({ self: this }, function* () { return yield* this.take; }); } }`,
    `${effect}const pool = { acquire: () => Effect.gen({ self: pool }, function* () { return 1; }) };`,
    // Class methods keep their form.
    `${effect}class Store { load(id: string) { return Effect.gen(function* () { return yield* read(id); }); } }`,
    // Async and generator functions do not return an Effect.gen.
    `${effect}async function load(id: string) { return Effect.gen(function* () { return yield* read(id); }); }`,
    `${effect}function* load(id: string) { return Effect.gen(function* () { return yield* read(id); }); }`,
    // Overloads need multiple signatures.
    [
      effect,
      "export function load(id: string): Effect.Effect<Item>;",
      "export function load(id: number): Effect.Effect<Item>;",
      "export function load(id: string | number) { return Effect.gen(function* () { return yield* read(id); }); }",
    ].join("\n"),
    [
      effect,
      "export namespace Store {",
      "  export function load(id: string): Effect.Effect<Item>;",
      "  export function load(id: number): Effect.Effect<Item>;",
      "  export function load(id: string | number) { return Effect.gen(function* () { return yield* read(id); }); }",
      "}",
    ].join("\n"),
    [
      effect,
      "export default function load(id: string): Effect.Effect<Item>;",
      "export default function load(id: number): Effect.Effect<Item>;",
      "export default function load(id: string | number) { return Effect.gen(function* () { return yield* read(id); }); }",
    ].join("\n"),
    `${effect}const state = { get current() { return Effect.gen(function* () { return yield* read; }); } };`,
    `${effect}const load = (id: string) => Effect.map(read(id), parse);`,
    // Only Effect's own gen counts, resolved through its import.
    "const load = (id: string) => Effect.gen(function* () { return yield* read(id); });",
    'import * as Stream from "effect/Stream";\nconst load = (id: string) => Stream.gen(function* () { return yield* read(id); });',
  ],
  invalid: [
    {
      code: `${effect}const load = (id: string) => Effect.gen(function* () { return yield* read(id); });`,
      errors: [{ ...error, data: { name: "load" } }],
    },
    {
      code: `${effect}const identity = <A,>(value: A) => Effect.gen(function* () { return value; });`,
      errors: [error],
    },
    {
      code: `${effect}function load(id: string) { return Effect.gen(function* () { return yield* read(id); }); }`,
      errors: [error],
    },
    {
      code: `${effect}export function load(id: string) { return Effect.gen(function* () { return yield* read(id); }); }`,
      errors: [{ ...error, data: { name: "load" } }],
    },
    {
      // Members of object literals are named, including method shorthand.
      code: `${effect}export const service = { stop: () => Effect.gen(function* () { yield* close; }), start(id: string) { return Effect.gen(function* () { yield* open(id); }); } };`,
      errors: [
        { ...error, data: { name: "stop" } },
        { ...error, data: { name: "start" } },
      ],
    },
    {
      code: `${effect}class Store { readonly #load = (id: string) => (Effect.gen(function* () { return yield* read(id); })); }`,
      errors: [{ ...error, data: { name: "load" } }],
    },
    {
      // Effect.fn accepts pipeable post-steps as further arguments.
      code: `${effect}const load = (id: string) => Effect.gen(function* () { return yield* read(id); }).pipe(Effect.withSpan("load"), Effect.orDie);`,
      errors: [{ ...error, data: { name: "load" } }],
    },
    {
      code: `${effect}function load(id: string) { return Effect.gen(function* () { return yield* read(id); }).pipe(Effect.orDie).pipe(Effect.asVoid); }`,
      errors: [{ ...error, data: { name: "load" } }],
    },
    {
      code: 'import * as Fx from "effect/Effect";\nconst load = (id: string) => Fx.gen(function* () { return yield* read(id); });',
      errors: [{ ...error, data: { name: "load" } }],
    },
    {
      code: 'import { gen as effectGen } from "effect/Effect";\nconst load = (id: string) => effectGen(function* () { return yield* read(id); });',
      errors: [{ ...error, data: { name: "load" } }],
    },
  ],
});
