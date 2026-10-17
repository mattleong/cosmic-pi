import { RuleTester } from "oxlint/plugins-dev";

import { noManualEffectErrorTagRule } from "./no-manual-effect-error-tag.ts";

new RuleTester().run("no-manual-effect-error-tag", noManualEffectErrorTagRule, {
  valid: [
    'Effect.catchTag("NotFound", recover);',
    'Effect.catchTag("Wrapper", (error) => error.reason._tag === "Timeout" ? retry : fail);',
  ],
  invalid: [
    {
      code: 'Effect.catch((error) => error._tag === "NotFound" ? recover : fail);',
      errors: [{ messageId: "tag" }],
    },
    {
      code: 'Effect.catchAll(function (error) { return error.reason._tag === "Timeout" ? retry : fail; });',
      errors: [{ messageId: "reason" }],
    },
  ],
});
