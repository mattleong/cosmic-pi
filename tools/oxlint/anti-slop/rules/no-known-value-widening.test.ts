import { RuleTester } from "oxlint/plugins-dev";

import { noKnownValueWideningRule } from "./no-known-value-widening.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

const error = { messageId: "widening" };

const prelude = "type Command = () => void; const startCommand = () => {};";

tester.run("anti-slop/no-known-value-widening", noKnownValueWideningRule, {
  valid: [
    `${prelude} const commands: Record<string, Command> = {};`,
    `${prelude} const commands = { start: startCommand } satisfies Record<string, Command>;`,
    `${prelude} interface Commands { readonly start: Command } const commands: Commands = { start: startCommand };`,
    `${prelude} type Diet = 'vegan' | 'omnivore'; const labels: Record<Diet, string> = { vegan: 'V', omnivore: 'O' };`,
    "function isString(value: unknown): value is string { return true; } declare const input: unknown; isString(input);",
  ],
  invalid: [
    { code: "const value: unknown = {};", errors: [error] },
    {
      code: `${prelude} const commands: Record<string, Command> = { start: startCommand };`,
      errors: [error],
    },
    {
      code: `${prelude} const commands = { start: startCommand } as Record<string, Command>;`,
      errors: [error],
    },
    {
      code: `${prelude} type Index<T> = Record<string, T>; const commands: Index<Command> = { start: startCommand };`,
      errors: [error],
    },
    {
      code: "function isString(value: unknown): value is string { return true; } isString('known');",
      errors: [error],
    },
  ],
});
