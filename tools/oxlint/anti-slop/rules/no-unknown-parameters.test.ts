import { RuleTester } from "oxlint/plugins-dev";

import { noUnknownParametersRule } from "./no-unknown-parameters.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "unknownParameter" };

tester.run("anti-slop/no-unknown-parameters", noUnknownParametersRule, {
  valid: [
    "function enrich(cause: unknown): void {}",
    "function isString(value: unknown): value is string { return true; }",
    "function assertString(value: unknown): asserts value is string {}",
    "const decode = (input: unknown) => Schema.decodeUnknownEffect(Config)(input);",
    "function parse(input: unknown) { return Schema.decodeUnknownSync(Config)(input, { onExcessProperty: 'error' }); }",
    "const decodeConfig = Schema.decodeUnknownOption(Config); const read = (input: unknown) => decodeConfig(input);",
    "function render(value: unknown) { if (!Schema.is(Shape)(value)) return fallback; return draw(value); }",
    "const load = Effect.fn('load')(function* (raw: unknown) { const config = yield* Schema.decodeUnknownEffect(Config)(raw); return config; });",
  ],
  invalid: [
    { code: "function parse(value: unknown): void {}", errors: [error] },
    {
      code: "function parse(value: unknown) { log(value); return Schema.decodeUnknownSync(Config)(value); }",
      errors: [error],
    },
    { code: "const parse = (value: unknown) => JSON.decode(Config)(value);", errors: [error] },
    {
      code: "const parse = (value: unknown) => Schema.decodeUnknownSync(value)(input);",
      errors: [error],
    },
    { code: "type Parser = (value: unknown) => void;", errors: [error] },
    {
      code: "function isString(value: unknown, context: unknown): value is string { return true; }",
      errors: [{ ...error, data: { parameter: "context" } }],
    },
  ],
});
