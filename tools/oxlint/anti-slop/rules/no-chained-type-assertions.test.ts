import { RuleTester } from "oxlint/plugins-dev";

import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const value = input as User;",
    "const value = [1, 2] as const;",
    "const value = ([1, 2] as const) as const;",
    "const value = (input as User)!;",
  ],
  invalid: [
    { code: "const value = input as object as User;", errors: [error] },
    { code: "const value = (input as object) as User;", errors: [error] },
    { code: "const value = <User><object>input;", errors: [error] },
  ],
});
