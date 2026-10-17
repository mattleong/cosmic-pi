import { RuleTester } from "oxlint/plugins-dev";

import { preferEffectMatchRule } from "./prefer-effect-match.ts";

new RuleTester().run("prefer-effect-match", preferEffectMatchRule, {
  valid: [
    'kind === "a" ? first : fallback;',
    'kind === "a" ? first : other === "b" ? second : fallback;',
  ],
  invalid: [
    {
      code: 'kind === "a" ? first : kind === "b" ? second : fallback;',
      errors: [{ messageId: "preferMatch" }],
    },
  ],
});
