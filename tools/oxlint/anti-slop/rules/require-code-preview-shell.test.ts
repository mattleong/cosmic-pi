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
      `export function register(pi, shell: typeof withCodePreviewShell = withCodePreviewShell) { pi.registerTool(shell(tool, options)); }`,
    ),
    valid(
      `const replay = registerCodePreviewReplay(pi, options); pi.registerTool(replay.shell(tool));`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); wrapped.execute = run; pi.registerTool(wrapped);`,
    ),
    {
      filename: "/repo/packages/pi-code-previews/src/tools/renderers/registration.ts",
      code: `pi.registerTool({ ...definition, defaultActive: active });`,
    },
    {
      filename: "/repo/packages/pi-owner/tests/tools/harness.ts",
      code: `pi.registerTool({ name: 'fake', execute });`,
    },
  ],
  invalid: [
    invalid("plain definition", `pi.registerTool({ name: 'owned', execute });`),
    invalid("registration function alias", `const register = pi.registerTool; register(tool);`),
    invalid(
      "renderer assignment",
      `const wrapped = withCodePreviewShell(tool); wrapped.renderResult = raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "Object.assign renderer mutation",
      `const wrapped = withCodePreviewShell(tool); Object.assign(wrapped, { renderResult: raw }); pi.registerTool(wrapped);`,
    ),
    invalid(
      "renderer override after the shell spread",
      `const wrapped = withCodePreviewShell(tool); pi.registerTool({ ...wrapped, renderResult: raw });`,
    ),
    invalid(
      "shadowed shell",
      `function register(pi) { const withCodePreviewShell = (tool) => tool; pi.registerTool(withCodePreviewShell(tool)); }`,
    ),
    invalid(
      "unannotated parameter",
      `function register(pi, shell) { pi.registerTool(shell(tool)); }`,
    ),
    invalid(
      "one conditional branch is unwrapped",
      `pi.registerTool(active ? withCodePreviewShell(first) : second);`,
    ),
    {
      name: "only the Code Previews write hook is exempt in its package",
      filename: "/repo/packages/pi-code-previews/src/tools/renderers/other.ts",
      code: `pi.registerTool({ ...definition, defaultActive: active });`,
      errors: [error],
    },
  ],
});
