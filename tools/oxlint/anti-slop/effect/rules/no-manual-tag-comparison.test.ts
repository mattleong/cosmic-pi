import { RuleTester } from "oxlint/plugins-dev";

import { noManualTagComparisonRule } from "./no-manual-tag-comparison.ts";

const comparison = { messageId: "manualComparison" };

new RuleTester().run("no-manual-tag-comparison", noManualTagComparisonRule, {
  valid: [
    'Predicate.isTagged("Ready")(value);',
    'if (value.status === "Ready") handleReady(value);',
    'value?.status === "Ready";',
    "left._tag === right._tag;",
  ],
  invalid: [
    { code: 'value._tag === "Ready";', errors: [comparison] },
    { code: '"Ready" !== value["_tag"];', errors: [comparison] },
    { code: 'value?._tag === "Ready";', errors: [comparison] },
    { code: 'state.current?.result._tag !== "Done";', errors: [comparison] },
    {
      code: 'Effect.catch((error) => error._tag === "NotFound" ? recover : Effect.fail(error));',
      errors: [comparison],
    },
    {
      code: 'switch (value._tag) { case "Ready": handleReady(value); }',
      errors: [{ messageId: "manualSwitch" }],
    },
    {
      code: 'switch (value?._tag) { case "Ready": handleReady(value); }',
      errors: [{ messageId: "manualSwitch" }],
    },
  ],
});
