import { RuleTester } from "oxlint/plugins-dev";

import { noForbiddenTermInSymbolNamesRule } from "./no-shape-in-symbol-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "tsx" } } });
const error = { messageId: "forbiddenSymbolName" };

tester.run("anti-slop/no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: [
    "const userContract = 1;",
    "const owner = { 'user-shape': true };",
    "const element = <Owner />;",
  ],
  invalid: [
    { code: "let userShape;", errors: [error] },
    { code: "class Owner { #shape = 1; }", errors: [error] },
    { code: "const element = <Shape />;", errors: [error] },
  ],
});
