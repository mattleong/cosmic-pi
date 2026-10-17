import { RuleTester } from "oxlint/plugins-dev";

import { noUnsafeDictionaryTypeRule } from "./no-unsafe-dictionary-type.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const error = { messageId: "unsafeDictionary" };

tester.run("anti-slop/no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
  valid: [
    "type Commands = Record<string, Command>;",
    "type PermissionLevels = Record<Permission, number>;",
    "type Allowed = Record<string, { payload: unknown }>;",
    "type A = Map<string, unknown>;",
    "import { Record } from './local'; type A = Record<string, unknown>;",
    "function run<T extends Record<string, unknown>>(input: T): T { return input; }",
  ],
  invalid: [
    { code: "type A = Record<string, unknown>;", errors: [error] },
    { code: "type A = { [key: string]: any };", errors: [error] },
    { code: "type A = Record<string, {}>;", errors: [error] },
    { code: "type Escape = unknown; type A = Record<string, Escape>;", errors: [error] },
    { code: "type Index<T> = Record<string, T>; type A = Index<unknown>;", errors: 1 },
  ],
});
