import { RuleTester } from "oxlint/plugins-dev";

import { noEffectRunnerImportsRule } from "./no-effect-runner-imports.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "runnerImport" };

tester.run("anti-slop-effect/no-effect-runner-imports", noEffectRunnerImportsRule, {
  valid: [
    // The property ban covers `Effect.run*` through a namespace import.
    'import * as Effect from "effect/Effect";',
    'import { gen, succeed } from "effect/Effect";',
    'import type { runPromise } from "effect/Effect";',
    'import { type runPromise, gen } from "effect/Effect";',
    'import { runPromise } from "./local-runtime.ts";',
    'export { gen } from "effect/Effect";',
  ],
  invalid: [
    { code: 'import { runPromise } from "effect/Effect";', errors: [error] },
    { code: 'import { gen, runSync as run } from "effect/Effect";', errors: [error] },
    { code: 'export { runFork } from "effect/Effect";', errors: [error] },
    { code: 'export { runPromiseExit as exit } from "effect/Effect";', errors: [error] },
  ],
});
