import { RuleTester } from "oxlint/plugins-dev";

import { noRawHostNotifyRule, notifyBoundaryFiles } from "./no-raw-host-notify.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "rawNotify" };
const feature = "/repo/packages/pi-example/src/settings/controller.ts";

tester.run("anti-slop/no-raw-host-notify", noRawHostNotifyRule, {
  valid: [
    { filename: feature, code: 'notifyAtHostBoundary(ctx, "Saved.", "info");' },
    { filename: feature, code: "expect(ctx.ui.notify).toHaveBeenCalled();" },
    ...notifyBoundaryFiles.map((path) => ({
      filename: `/repo/${path}`,
      code: 'ctx.ui.notify("Saved.", "info");',
    })),
  ],
  invalid: [
    { filename: feature, code: 'ctx.ui.notify("Saved.", "info");', errors: [error] },
    { filename: feature, code: 'ctx?.ui?.notify?.("Saved.");', errors: [error] },
    {
      filename: "/repo/packages/pi-example/tests/settings.test.ts",
      code: 'ctx.ui.notify("Saved.");',
      errors: [error],
    },
  ],
});
