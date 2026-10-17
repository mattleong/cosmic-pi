import { RuleTester } from "oxlint/plugins-dev";

import { abortBoundaryFiles, noManualAbortListenerRule } from "./no-manual-abort-listener.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "manualAbortListener" };
const feature = "/repo/packages/pi-example/src/tasks/runner.ts";

tester.run("anti-slop/no-manual-abort-listener", noManualAbortListenerRule, {
  valid: [
    { filename: feature, code: 'button.addEventListener("click", stop);' },
    ...abortBoundaryFiles.map((path) => ({
      filename: `/repo/${path}`,
      code: 'source.addEventListener("abort", forward, { once: true });',
    })),
  ],
  invalid: [
    {
      filename: feature,
      code: 'signal.addEventListener("abort", stop, { once: true });',
      errors: [error],
    },
    {
      filename: "/repo/packages/pi-example/tests/dialogs.test.ts",
      code: 'options.signal.addEventListener("abort", () => answer.resolve(undefined));',
      errors: [error],
    },
  ],
});
