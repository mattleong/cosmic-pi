import { RuleTester } from "oxlint/plugins-dev";

import { noManualTaggedConstructionRule } from "./no-manual-tagged-construction.ts";

new RuleTester().run("no-manual-tagged-construction", noManualTaggedConstructionRule, {
  valid: [
    'Match.when({ _tag: "Ready" }, handleReady);',
    "Ready.make({ value });",
    'PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "open" });',
  ],
  invalid: [
    {
      code: 'PlatformError.systemError(options, { _tag: "NotFound" });',
      errors: [{ messageId: "manualConstruction" }],
    },
    {
      code: 'const value = { _tag: "Ready", payload };',
      errors: [{ messageId: "manualConstruction" }],
    },
  ],
});
