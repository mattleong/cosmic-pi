import { RuleTester } from "oxlint/plugins-dev";

import { requireCodePreviewShellRule } from "./require-code-preview-shell.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const source = "/repo/packages/pi-owner/src/tools/owned.ts";
const imports = `import { withCodePreviewShell, registerCodePreviewReplay } from 'pi-code-previews';`;
const error = { messageId: "unwrappedTool" };

const valid = (code: string) => ({ filename: source, code: `${imports} ${code}` });
const invalid = (name: string, code: string) => ({
  name,
  filename: source,
  code: `${imports} ${code}`,
  errors: [error],
});

tester.run("anti-slop/require-code-preview-shell", requireCodePreviewShellRule, {
  valid: [
    valid(`pi.registerTool(withCodePreviewShell(tool, options));`),
    valid(`const wrapped = withCodePreviewShell(tool, options); pi.registerTool(wrapped);`),
    valid(
      `const wrapped = withCodePreviewShell(tool, options); pi.registerTool({ ...wrapped, execute: (...input) => wrapped.execute(...input) });`,
    ),
    valid(`const wrap = withCodePreviewShell; pi.registerTool(wrap(tool));`),
    `import * as previews from 'pi-code-previews'; pi.registerTool(previews.withCodePreviewShell(tool));`,
    `import { withCodePreviewShell } from 'pi-code-previews/shell'; pi.registerTool(withCodePreviewShell(tool));`,
    valid(
      `export function register(pi, shell: typeof withCodePreviewShell = withCodePreviewShell) { pi.registerTool(shell(tool, options)); }`,
    ),
    valid(
      `export function register(pi, { noteCwd, shell = withCodePreviewShell }: Options) { pi.registerTool(shell(tool, { noteCwd })); }`,
    ),
    valid(
      `export function register(pi, shell: typeof withCodePreviewShell) { pi.registerTool(shell(tool)); }`,
    ),
    valid(
      `export function register(pi, shell = withCodePreviewShell) { const wrapped = shell(tool); pi.registerTool({ ...wrapped, execute: run }); }`,
    ),
    valid(
      `const replay = registerCodePreviewReplay(pi, options); pi.registerTool(replay.shell(tool));`,
    ),
    valid(
      `const replay = registerCodePreviewReplay(pi, options); const shell = replay.shell; pi.registerTool(shell(tool));`,
    ),
    valid(
      `const resultTool = (document) => withCodePreviewShell({ ...renderers, name: document.name }); const register = (document) => pi.registerTool(resultTool(document));`,
    ),
    valid(
      `function resultTool(document) { const name = document.name; return withCodePreviewShell({ name }); } pi.registerTool(resultTool(document));`,
    ),
    valid(`pi.registerTool(active ? withCodePreviewShell(first) : withCodePreviewShell(second));`),
    {
      filename: "/repo/packages/pi-code-previews/src/tools/renderers/registration.ts",
      code: `pi.registerTool({ ...definition, defaultActive: active });`,
    },
    {
      filename: "/repo/packages/pi-owner/tests/tools/harness.ts",
      code: `pi.registerTool({ name: 'fake', execute });`,
    },
    {
      filename: "C:\\repo\\packages\\pi-owner\\tests\\fixture.ts",
      code: `pi.registerTool(fake);`,
    },
    valid(`pi.registerToolRenderer((name, next) => next());`),
  ],
  invalid: [
    invalid("plain definition", `pi.registerTool({ name: 'owned', execute });`),
    invalid("defineTool result", `pi.registerTool(defineTool({ name: 'owned', execute }));`),
    invalid("unwrapped const", `const tool = defineTool(definition); pi.registerTool(tool);`),
    invalid(
      "renderer override after the shell spread",
      `const wrapped = withCodePreviewShell(tool); pi.registerTool({ ...wrapped, renderResult: raw });`,
    ),
    invalid(
      "computed override after the shell spread",
      `const wrapped = withCodePreviewShell(tool); pi.registerTool({ ...wrapped, [field]: raw });`,
    ),
    invalid(
      "later spread may replace renderers",
      `const wrapped = withCodePreviewShell(tool); pi.registerTool({ ...wrapped, ...overrides });`,
    ),
    invalid(
      "shadowed shell",
      `function register(pi) { const withCodePreviewShell = (tool) => tool; pi.registerTool(withCodePreviewShell(tool)); }`,
    ),
    invalid(
      "same-named function from another package",
      `import { withCodePreviewShell as wrap } from './local-shell'; pi.registerTool(wrap(tool));`,
    ),
    invalid(
      "type-only import",
      `import type { withCodePreviewShell as wrap } from 'pi-code-previews'; pi.registerTool(wrap(tool));`,
    ),
    invalid(
      "unannotated parameter",
      `function register(pi, shell) { pi.registerTool(shell(tool)); }`,
    ),
    invalid(
      "reassigned shell parameter",
      `function register(pi, shell = withCodePreviewShell) { shell = (tool) => tool; pi.registerTool(shell(tool)); }`,
    ),
    invalid(
      "shell of an unrelated object",
      `const replay = createReplay(pi); pi.registerTool(replay.shell(tool));`,
    ),
    invalid(
      "one conditional branch is unwrapped",
      `pi.registerTool(active ? withCodePreviewShell(first) : second);`,
    ),
    invalid(
      "helper with an unwrapped return",
      `const resultTool = (document) => ({ ...renderers, name: document.name }); pi.registerTool(resultTool(document));`,
    ),
    invalid("missing definition", `pi.registerTool();`),
    invalid("spread argument", `pi.registerTool(...definitions);`),
    invalid("computed registerTool access", `pi['registerTool']({ name: 'owned', execute });`),
    {
      name: "only the Code Previews write hook is exempt in its package",
      filename: "/repo/packages/pi-code-previews/src/tools/renderers/other.ts",
      code: `pi.registerTool({ ...definition, defaultActive: active });`,
      errors: [error],
    },
    {
      name: "a package merely named like Code Previews is not exempt",
      filename: "/repo/packages/pi-code-previews-extra/src/tools/renderers/registration.ts",
      code: `pi.registerTool({ name: 'owned', execute });`,
      errors: [error],
    },
  ],
});
