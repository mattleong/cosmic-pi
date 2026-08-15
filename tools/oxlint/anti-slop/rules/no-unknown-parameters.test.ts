import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function enrich(cause: unknown): void {}",
    "type UnknownValue = unknown; function parse(value: UnknownValue): void {}",
    "function parse(value: unknown | string): void {}",
    "function load(): unknown { return input; }",
  ],
  invalid: [
    { code: "function parse(value: unknown): void {}", errors: [error] },
    { code: "const parse = (value: unknown): void => {};", errors: [error] },
    { code: "function parse(...values: unknown): void {}", errors: [error] },
    { code: "type Parser = (value: unknown) => void;", errors: [error] },
    { code: "interface Parser { parse(value: unknown): void; }", errors: [error] },
  ],
});
