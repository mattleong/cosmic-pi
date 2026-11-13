import { RuleTester } from "oxlint/plugins-dev";

import { noBooleanFilterRule } from "./no-boolean-filter.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "booleanFilter" };
const arr = 'import * as Arr from "effect/Array";\n';
const predicate = 'import * as Predicate from "effect/Predicate";\n';
const fn = 'import * as Fn from "effect/Function";\n';

tester.run("anti-slop-effect/no-boolean-filter", noBooleanFilterRule, {
  valid: [
    `${arr}${predicate}const text = Arr.join(Arr.filter(parts, Predicate.isString), " ");`,
    `${arr}import * as Str from "effect/String";\nconst names = Arr.filter(lines, Str.isNonEmpty);`,
    `${arr}${predicate}const kept = Arr.filter(parts, (part): part is string => Predicate.isString(part) && part.length > 0);`,
    `${arr}${fn}${predicate}const kept = Fn.pipe(parts, Arr.filter(Predicate.isNotNullish));`,
    // Other operations and other predicate positions are out of scope.
    `${arr}const flags = Arr.map(values, Boolean);`,
    `${arr}const kept = Arr.filter(Boolean ? items : [], isKept);`,
    // Only the global `Boolean` and Effect's `isTruthy` count.
    `${arr}const kept = (Boolean: (value: Item) => boolean) => Arr.filter(items, Boolean);`,
    `${arr}import * as Predicate from "./predicates.ts";\nconst kept = Arr.filter(items, Predicate.isTruthy);`,
    // Only `effect/Array` counts, resolved through its import.
    "const kept = Arr.filter(items, Boolean);",
    'import * as Arr from "./arrays.ts";\nconst kept = Arr.filter(items, Boolean);',
    'import * as Option from "effect/Option";\nconst kept = Option.filter(value, Boolean);',
    "const kept = items.filter(Boolean);",
  ],
  invalid: [
    {
      code: `${arr}const kept = Arr.filter(parts, Boolean);`,
      errors: [{ ...error, data: { predicate: "Boolean" } }],
    },
    {
      code: `${arr}${fn}const kept = Fn.pipe(parts, Arr.filter(Boolean));`,
      errors: [{ ...error, data: { predicate: "Boolean" } }],
    },
    {
      code: `${arr}${predicate}const kept = Arr.filter(parts, Predicate.isTruthy);`,
      errors: [{ ...error, data: { predicate: "Predicate.isTruthy" } }],
    },
    {
      code: `${arr}${fn}${predicate}const kept = Fn.pipe(parts, Arr.filter(Predicate.isTruthy));`,
      errors: [{ ...error, data: { predicate: "Predicate.isTruthy" } }],
    },
    {
      code: 'import * as A from "effect/Array";\nimport * as P from "effect/Predicate";\nconst kept = [A.filter(parts, Boolean), A.filter(parts, P.isTruthy)];',
      errors: [error, error],
    },
    {
      code: `${arr}import { isTruthy } from "effect/Predicate";\nconst kept = Arr.filter(parts, isTruthy);`,
      errors: [{ ...error, data: { predicate: "Predicate.isTruthy" } }],
    },
    {
      code: 'import { filter } from "effect/Array";\nconst kept = filter(parts, Boolean);',
      errors: [error],
    },
  ],
});
