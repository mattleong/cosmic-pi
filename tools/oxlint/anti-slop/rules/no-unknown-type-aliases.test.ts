import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownTypeAliasesRule } from "./no-unknown-type-aliases.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownAlias" };

tester.run("anti-slop/no-unknown-type-aliases", noUnknownTypeAliasesRule, {
  valid: [
    "type User = { readonly id: string };",
    "type Box<T> = { readonly value: T }; type Payload = Box<unknown>;",
  ],
  invalid: [
    { code: "type Alias = unknown;", errors: [error] },
    { code: "type Payload = string | unknown;", errors: [error] },
    {
      code: "type Identity<T> = T; type Payload = Identity<unknown>;",
      errors: [error],
    },
  ],
});
