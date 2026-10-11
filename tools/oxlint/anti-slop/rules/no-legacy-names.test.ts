import { RuleTester } from "oxlint/plugins-dev";

import { noCompatibilityPathNamesRule } from "./no-legacy-names.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "retiredPathName" };

tester.run("anti-slop/no-legacy-names", noCompatibilityPathNamesRule, {
  valid: [
    "const compat = model.compat;",
    'import { getModel } from "@earendil-works/pi-ai/compat";',
    "const callbackCompatible = true;",
    "function fallbackCompat() {}",
    "const playbackCompatMode = 1;",
    'const label = "legacy";',
    "const options = { 'deprecated-flag': true };",
  ],
  invalid: [
    { name: "binding", code: "const legacyMode = true;", errors: [error] },
    {
      name: "reference",
      code: "declare const legacyStore: number; const store = legacyStore;",
      errors: [error, error],
    },
    { name: "property key", code: "const options = { useLegacy: true };", errors: [error] },
    { name: "member property", code: "settings.isDeprecated = false;", errors: [error] },
    { name: "type name", code: "type LegacyConfig = { readonly path: string };", errors: [error] },
    { name: "type reference", code: "declare const config: LegacyConfig;", errors: [error] },
    {
      name: "private name",
      code: "class Store { #deprecatedCache = 1; read() { return this.#deprecatedCache; } }",
      errors: [error, error],
    },
    { name: "back compat", code: "function readBackCompat() {}", errors: [error] },
    { name: "lowercase", code: "const backcompat = 1;", errors: [error] },
    { name: "backward compat", code: "const backwardCompatPath = 1;", errors: [error] },
    { name: "backwards compat", code: "const BACKWARDS_COMPAT = 1;", errors: [error] },
    { name: "backwards compatible", code: "const isBackwardsCompatible = 1;", errors: [error] },
    { name: "shorthand", code: "const value = { legacyValue };", errors: [error] },
    { name: "import", code: 'import { legacyValue } from "./values.ts";', errors: [error] },
  ],
});
