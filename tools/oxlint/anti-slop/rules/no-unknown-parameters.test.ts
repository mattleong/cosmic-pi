import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function enrich(cause: unknown): void {}",
    "function isString(value: unknown): value is string { return true; }",
    "function assertString(value: unknown): asserts value is string {}",
  ],
  invalid: [
    { code: "function parse(value: unknown): void {}", errors: [error] },
    { code: "type Parser = (value: unknown) => void;", errors: [error] },
    {
      code: "function isString(value: unknown, context: unknown): value is string { return true; }",
      errors: [{ ...error, data: { parameter: "context" } }],
    },
  ],
});
