import { RuleTester } from "oxlint/plugins-dev";

import { noCurriedStringCallRule } from "./no-curried-string-call.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "curriedStringCall" };
const str = 'import * as Str from "effect/String";\n';
const fn = 'import * as Fn from "effect/Function";\n';
const arr = 'import * as Arr from "effect/Array";\n';

tester.run("anti-slop-effect/no-curried-string-call", noCurriedStringCallRule, {
  valid: [
    `${str}const parts = Str.split(text, "/");`,
    `${str}const name = Str.toLowerCase(Str.trim(text));`,
    `${str}${fn}const tail = Fn.pipe(text, Str.slice(1));`,
    `${str}${fn}const tail = Fn.pipe(text, Str.trim, Str.replaceAll("-", "_"), Str.slice(0, 8));`,
    // A data-last step passed as an argument is a pipeline step, not a direct call.
    `${str}${arr}const rows = Arr.map(lines, Str.split(","));`,
    `${str}${fn}const normalize = Fn.flow(Str.trim, Str.replaceAll(" ", "-"));`,
    `${str}const starts = Str.startsWith("--");`,
    // A method on the result of a data-first call is not a curried call.
    `${str}const padded = Str.trim(text).normalize();`,
    // Only `effect/String` counts, resolved through its import.
    "const tail = Str.slice(1)(text);",
    'import * as Str from "./strings.ts";\nconst tail = Str.slice(1)(text);',
    'import type * as Str from "effect/String";\nconst tail = Str.slice(1)(text);',
    `${arr}const kept = Arr.filter(isKept)(items);`,
    `${str}const tail = (Str: Local) => Str.slice(1)(text);`,
    "const tail = make(1)(text);",
  ],
  invalid: [
    {
      code: `${str}const tail = Str.slice(1)(text);`,
      errors: [{ ...error, data: { name: "slice" } }],
    },
    {
      code: `${str}const parts = Str.split("/")(path);`,
      errors: [{ ...error, data: { name: "split" } }],
    },
    {
      code: `${str}const flag = (Str.startsWith("--"))(argument);`,
      errors: [{ ...error, data: { name: "startsWith" } }],
    },
    {
      // Each direct call is reported, including one nested in another's argument.
      code: `${str}const name = Str.replaceAll("-", "_")(Str.slice(0, 8)(text));`,
      errors: [
        { ...error, data: { name: "replaceAll" } },
        { ...error, data: { name: "slice" } },
      ],
    },
    {
      code: 'import * as S from "effect/String";\nconst tail = S.slice(1)(text);',
      errors: [{ ...error, data: { name: "slice" } }],
    },
    {
      code: `${str}const Text = Str;\nconst tail = Text.slice(1)(text);`,
      errors: [{ ...error, data: { name: "slice" } }],
    },
    {
      code: 'import { slice } from "effect/String";\nconst tail = slice(1)(text);',
      errors: [{ ...error, data: { name: "slice" } }],
    },
  ],
});
