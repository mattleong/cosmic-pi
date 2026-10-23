import { eslintCompatPlugin } from "@oxlint/plugins";

import { noEffectRunnerImportsRule } from "./rules/no-effect-runner-imports.ts";
import { noManualTagComparisonRule } from "./rules/no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./rules/no-manual-tagged-construction.ts";
import { noServiceConstructorImportsRule } from "./rules/no-service-constructor-imports.ts";
import { preferEffectFnRule } from "./rules/prefer-effect-fn.ts";
import { preferEffectMatchRule } from "./rules/prefer-effect-match.ts";

/** Opt-in Oxlint rules for Effect service and Layer architecture. */
const antiSlopEffectPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop-effect" },
  rules: {
    "no-effect-runner-imports": noEffectRunnerImportsRule,
    "no-manual-tag-comparison": noManualTagComparisonRule,
    "no-manual-tagged-construction": noManualTaggedConstructionRule,
    "no-service-constructor-imports": noServiceConstructorImportsRule,
    "prefer-effect-fn": preferEffectFnRule,
    "prefer-effect-match": preferEffectMatchRule,
  },
});

export default antiSlopEffectPlugin;
