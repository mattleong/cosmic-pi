import { RuleTester } from "oxlint/plugins-dev";

import { noReduceAccumulatorCopyRule } from "./no-reduce-accumulator-copy.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "accumulatorCopy" };

tester.run("anti-slop/no-reduce-accumulator-copy", noReduceAccumulatorCopyRule, {
  valid: [
    "items.reduce((acc, item) => { acc.push(item); return acc; }, []);",
    "items.reduce((acc, item) => Object.assign(acc, item), {});",
    "const Object = custom; items.reduce((acc, item) => Object.assign({}, acc), {});",
  ],
  invalid: [
    {
      code: "items.reduce((acc, item) => Object.assign({}, acc, { [item.id]: item }), {});",
      errors: [error],
    },
    { code: "items.reduce((acc, item) => acc.concat([item]), []);", errors: [error] },
    {
      code: "items.reduce((acc, item) => { const next = acc.slice(); next.push(item); return next; }, []);",
      errors: [error],
    },
  ],
});
