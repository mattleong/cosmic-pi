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
    valid(`const register = pi.registerTool; register(withCodePreviewShell(tool));`),
    valid(`const { registerTool: register } = pi; register(withCodePreviewShell(tool));`),
    valid(
      `const wrapped = withCodePreviewShell(tool); const first = second; const second = first; pi.registerTool(wrapped);`,
    ),
    valid(
      `const register = pi.registerTool.bind(pi); const alias = register; alias(withCodePreviewShell(tool));`,
    ),
    valid(`const register = pi.registerTool.bind(pi, withCodePreviewShell(tool)); register();`),
    valid(
      `const wrapped = withCodePreviewShell(tool); wrapped.execute = run; pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); Object.assign(wrapped, { execute: run, name: 'owned' }); pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); const changes = { execute: run }; pi.registerTool(Object.assign(wrapped, { ...changes, config: { renderResult: raw } }));`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); const alias = Object.assign(wrapped, { execute: run }); pi.registerTool(alias);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); wrapped.execute.renderResult = raw; pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); other.renderResult = raw; Object.assign(other, wrapped, { renderCall: raw }); pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); const copy = { ...wrapped }; copy.renderResult = raw; pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); const copy = Object.assign({}, wrapped); copy.renderResult = raw; pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); function change(wrapped) { wrapped.renderResult = raw; } pi.registerTool(wrapped);`,
    ),
    valid(
      `const wrapped = withCodePreviewShell(tool); function change(Object) { Object.assign(wrapped, { renderResult: raw }); } pi.registerTool(wrapped);`,
    ),
    valid(`const register = local; register(tool);`),
    valid(`const register = pi.registerTool; function unrelated(register) { register(tool); }`),
    valid(
      `const wrapped = withCodePreviewShell(tool); const alias = wrapped; alias['execute'] = run; delete wrapped.name; pi.registerTool(wrapped);`,
    ),
  ],
  invalid: [
    invalid("plain definition", `pi.registerTool({ name: 'owned', execute });`),
    invalid("registration function alias", `const register = pi.registerTool; register(tool);`),
    invalid(
      "destructured registration function",
      `const { registerTool: register } = pi; register(tool);`,
    ),
    invalid(
      "parenthesized renderer deletion",
      `const wrapped = withCodePreviewShell(tool); delete (wrapped.renderResult); pi.registerTool(wrapped);`,
    ),
    invalid(
      "bound registration function",
      `const register = pi.registerTool.bind(pi); const alias = register; alias(tool);`,
    ),
    invalid(
      "prebound unwrapped definition",
      `const register = pi.registerTool.bind(pi, tool); register(withCodePreviewShell(tool));`,
    ),
    invalid(
      "prebound spread definition",
      `const register = pi.registerTool.bind(pi, ...tools); register(withCodePreviewShell(tool));`,
    ),
    invalid(
      "spread bind arguments",
      `const register = pi.registerTool.bind(...input); register(withCodePreviewShell(tool));`,
    ),
    invalid(
      "renderer assignment",
      `const wrapped = withCodePreviewShell(tool); wrapped.renderResult = raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "renderer assignment through an alias",
      `const wrapped = withCodePreviewShell(tool); const alias = wrapped; alias.renderCall = raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "original mutation reaches alias",
      `const wrapped = withCodePreviewShell(tool); const alias = wrapped; wrapped.renderShell = raw; pi.registerTool(alias);`,
    ),
    invalid(
      "computed renderer assignment",
      `const wrapped = withCodePreviewShell(tool); wrapped['renderResult'] = raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "unknown field assignment",
      `const wrapped = withCodePreviewShell(tool); wrapped[field] = raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "renderer deletion",
      `const wrapped = withCodePreviewShell(tool); delete wrapped.renderCall; pi.registerTool(wrapped);`,
    ),
    invalid(
      "renderer logical assignment",
      `const wrapped = withCodePreviewShell(tool); wrapped.renderShell ||= raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "renderer update",
      `const wrapped = withCodePreviewShell(tool); wrapped.renderResult++; pi.registerTool(wrapped);`,
    ),
    invalid(
      "destructured renderer assignment",
      `const wrapped = withCodePreviewShell(tool); [wrapped.renderCall] = callbacks; pi.registerTool(wrapped);`,
    ),
    invalid(
      "Object.assign renderer mutation",
      `const wrapped = withCodePreviewShell(tool); Object.assign(wrapped, { renderResult: raw }); pi.registerTool(wrapped);`,
    ),
    invalid(
      "Object.assign aliased renderer source",
      `const wrapped = withCodePreviewShell(tool); const changes = { renderResult: raw }; Object.assign(wrapped, { ...changes }); pi.registerTool(wrapped);`,
    ),
    invalid(
      "Object.assign mutated execution-only source",
      `const wrapped = withCodePreviewShell(tool); const changes: Partial<typeof wrapped> = { execute: run }; changes.renderResult = raw; pi.registerTool(Object.assign(wrapped, changes));`,
    ),
    invalid(
      "Object.assign mutated source through a spread alias",
      `const wrapped = withCodePreviewShell(tool); const changes = { execute: run }; const alias = changes; alias.renderResult = raw; pi.registerTool(Object.assign(wrapped, { ...changes }));`,
    ),
    invalid(
      "Object.assign tracks transitive mutations independent of traversal order",
      `const wrapped = withCodePreviewShell(tool); const changes = { execute: run }; const inherited = {}; function register() { pi.registerTool(Object.assign(wrapped, changes)); } Object.assign(changes, inherited); inherited.renderResult = raw; register();`,
    ),
    invalid(
      "Object.assign unknown source",
      `const wrapped = withCodePreviewShell(tool); Object.assign(wrapped, changes); pi.registerTool(wrapped);`,
    ),
    invalid(
      "Object.assign result aliases its target",
      `const wrapped = withCodePreviewShell(tool); const alias = Object.assign(wrapped, { execute: run }); alias.renderCall = raw; pi.registerTool(wrapped);`,
    ),
    invalid(
      "mutation reaches assigned target result",
      `const wrapped = withCodePreviewShell(tool); const alias = Object.assign(wrapped, { renderResult: raw }); pi.registerTool(alias);`,
    ),
    invalid(
      "mutated helper result",
      `function make() { const wrapped = withCodePreviewShell(tool); wrapped.renderResult = raw; return wrapped; } pi.registerTool(make());`,
    ),
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
