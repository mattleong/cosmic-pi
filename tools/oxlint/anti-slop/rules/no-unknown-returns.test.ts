import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownReturnsRule } from "./no-unknown-returns.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownReturn" };

tester.run("anti-slop/no-unknown-returns", noUnknownReturnsRule, {
  valid: [
    "function parse(): User { return user; }",
    "function generic<Value>(): Value { return value; }",
    "function cause(): { cause: unknown } { return { cause: input }; }",
  ],
  invalid: [
    { code: "function load(): unknown { return input; }", errors: [error] },
    { code: "type Loader = () => unknown;", errors: [error] },
    { code: "function load(): Promise<unknown> { return promise; }", errors: [error] },
    {
      code: "type UnknownValue = unknown; function load(): UnknownValue { return input; }",
      errors: [error],
    },
  ],
});
