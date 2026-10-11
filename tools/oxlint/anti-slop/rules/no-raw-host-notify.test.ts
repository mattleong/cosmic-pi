import { RuleTester } from "oxlint/plugins-dev";

import { noRawHostNotifyRule, notifyBoundaryFiles } from "./no-raw-host-notify.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "rawNotify" };
const feature = "/repo/packages/pi-example/src/settings/controller.ts";

tester.run("anti-slop/no-raw-host-notify", noRawHostNotifyRule, {
  valid: [
    { filename: feature, code: 'notifyAtHostBoundary(ctx, "Saved.", "info");' },
    { filename: feature, code: "expect(ctx.ui.notify).toHaveBeenCalled();" },
    { filename: feature, code: "ctx.ui.notify.mockClear();" },
    { filename: feature, code: "ctx.ui.notify = () => undefined;" },
    { filename: feature, code: 'ctx.notify("Saved.");' },
    { filename: feature, code: 'ui.notify("Saved.");' },
    { filename: feature, code: 'ctx.ui.setStatus("Saved.");' },
    ...notifyBoundaryFiles.map((path) => ({
      filename: `/repo/${path}`,
      code: 'ctx.ui.notify("Saved.", "info");',
    })),
  ],
  invalid: [
    { filename: feature, code: 'ctx.ui.notify("Saved.", "info");', errors: [error] },
    { filename: feature, code: 'ctx?.ui?.notify?.("Saved.");', errors: [error] },
    { filename: feature, code: 'ctx.ui["notify"]("Saved.");', errors: [error] },
    { filename: feature, code: 'read().ui.notify("Saved.");', errors: [error] },
    { filename: feature, code: 'ctx.ui!.notify("Saved.");', errors: [error] },
    {
      filename: "/repo/packages/pi-cosmic-core/src/host-command.ts",
      code: 'ctx.ui.notify("Saved.");',
      errors: [error],
    },
    {
      filename: "/repo/packages/pi-example/tests/settings.test.ts",
      code: 'ctx.ui.notify("Saved.");',
      errors: [error],
    },
  ],
});
