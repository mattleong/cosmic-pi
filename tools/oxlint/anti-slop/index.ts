import { eslintCompatPlugin } from "@oxlint/plugins";

import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noEagerEffectFinalizerConditionRule } from "./rules/no-eager-effect-finalizer-condition.ts";
import { noEscapingRenderContextRule } from "./rules/no-escaping-render-context.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noLossyExpandedArgumentsRule } from "./rules/no-lossy-expanded-arguments.ts";
import { noManualAbortListenerRule } from "./rules/no-manual-abort-listener.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noRawHostNotifyRule } from "./rules/no-raw-host-notify.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noRuntimeTypeOnlyTestsRule } from "./rules/no-runtime-type-only-tests.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { requireCodePreviewShellRule } from "./rules/require-code-preview-shell.ts";

const antiSlopPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-eager-effect-finalizer-condition": noEagerEffectFinalizerConditionRule,
    "no-escaping-render-context": noEscapingRenderContextRule,
    "no-known-value-widening": noKnownValueWideningRule,
    "no-lossy-expanded-arguments": noLossyExpandedArgumentsRule,
    "no-manual-abort-listener": noManualAbortListenerRule,
    "no-module-mocking": noModuleMockingRule,
    "no-object-parameters": noObjectParametersRule,
    "no-raw-host-notify": noRawHostNotifyRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-runtime-type-only-tests": noRuntimeTypeOnlyTestsRule,
    "no-unsafe-dictionary-type": noUnsafeDictionaryTypeRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unknown-returns": noUnknownReturnsRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
    "require-code-preview-shell": requireCodePreviewShellRule,
  },
});

export default antiSlopPlugin;
