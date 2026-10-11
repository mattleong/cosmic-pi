import { RuleTester } from "oxlint/plugins-dev";

import { noLossyExpandedArgumentsRule } from "./no-lossy-expanded-arguments.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const imports = `
  import { Text } from '@earendil-works/pi-tui';
  import { stripTerminalControls, invokeHostCallback } from 'pi-cosmic-core';
`;
const error = { messageId: "lossyArguments" };

tester.run("anti-slop/no-lossy-expanded-arguments", noLossyExpandedArgumentsRule, {
  valid: [
    `${imports} const tool = { renderCall(args, theme) { return expandedArguments(theme, args); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(escapeControlChars(JSON.stringify(args)), 0, 0); } };`,
    // Summaries, logs, raw result text, and unrelated serialized diagnostics may be lossy.
    `${imports} const tool = { renderCall(args) { console.log(stripTerminalControls(JSON.stringify(args))); return new Text('ok', 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { const subject = stripTerminalControls(JSON.stringify(args)); console.log(subject); return new Text('ok', 0, 0); } };`,
    `${imports} const summary = (args) => stripTerminalControls(JSON.stringify(args));`,
    `${imports} const tool = { renderCall(args) { const text = stripTerminalControls(JSON.stringify(args)); return new Text(text ? 'Arguments present' : 'None', 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { const text = stripTerminalControls(JSON.stringify(args)); return new Text(text.length > 80 ? 'Large input' : 'Small input', 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { return new Text((console.log(stripTerminalControls(JSON.stringify(args))), 'done'), 0, 0); } };`,
    `${imports} const tool = { renderResult(result) { return new Text(stripTerminalControls(JSON.stringify(result)), 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(JSON.stringify({ action: args.action })), 0, 0); } };`,
    `${imports} const diagnostic = (args) => new Text(stripTerminalControls(JSON.stringify(args)), 0, 0); diagnostic(logRecord);`,
    `${imports} const tool = { renderCall(args) { const diagnostic = { elapsed: 10 }; return new Text(stripTerminalControls(JSON.stringify(diagnostic)), 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(getTextContent(args)), 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(JSON.stringify(args, ['action'])), 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(JSON.stringify(args, summarize)), 0, 0); } };`,
    // Local lookalikes, shadowed builtins, and type-only imports are not owned operations.
    `import { stripTerminalControls } from './security'; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args) { const stripTerminalControls = (text) => text; return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args, JSON) { return new Text(stripTerminalControls(JSON.stringify(args)), 0, 0); } };`,
    `${imports} const JSON = { stringify(value) { return value; } }; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args) { const invokeHostCallback = (f) => f(); return stripTerminalControls(invokeHostCallback(() => JSON.stringify(args))); } };`,
    `import type { stripTerminalControls } from 'pi-cosmic-core'; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `import { type stripTerminalControls } from 'pi-cosmic-core'; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    // No arbitrary return-flow analysis or mutable-alias guessing.
    `${imports} const tool = { renderCall(args) { const raw = format(JSON.stringify(args)); return stripTerminalControls(raw); } };`,
    `${imports} const tool = { renderCall(args) { let raw = JSON.stringify(args); raw = 'summary'; return stripTerminalControls(raw); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(JSON.stringify(args.action)), 0, 0); } };`,
    // A destructured binding holds one field, not the whole input.
    `${imports} const tool = { renderCall(args) { const { action } = args; return new Text(stripTerminalControls(JSON.stringify(action)), 0, 0); } };`,
  ],
  invalid: [
    {
      name: "const alias of the imported sanitizer",
      code: `${imports} const strip = stripTerminalControls; const tool = { renderCall(input) { return new Text(strip(JSON.stringify(input)), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "direct renderer input",
      code: `${imports} const tool = { renderCall(input) { return new Text(stripTerminalControls(JSON.stringify(input, null, 2)), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "serialized const intermediaries and input alias",
      code: `${imports} const tool = { renderCall(input) { const args = input; const raw = JSON.stringify(args); const text = stripTerminalControls(raw); return new Text(text, 0, 0); } };`,
      errors: [error],
    },
    {
      name: "import alias and direct renderer return",
      code: `import { stripTerminalControls as sanitizeTerminalText } from 'pi-cosmic-core'; const tool = { renderCall(args) { return sanitizeTerminalText(JSON.stringify(args)); } };`,
      errors: [error],
    },
    {
      name: "owned namespace and Text alias",
      code: `import * as core from 'pi-cosmic-core'; import { Text as Body } from '@earendil-works/pi-tui'; const tool = { renderCall(args) { return new Body(core.stripTerminalControls(JSON['stringify'](args)), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "historical background-task renderArguments wrapper",
      code: `${imports}
        import { stripTerminalControls as sanitizeTerminalText, invokeHostCallback as invoke } from 'pi-cosmic-core';
        const renderArguments = (args, theme) => expandedSection(theme, 'Arguments',
          new Text(theme.fg('toolOutput', sanitizeTerminalText(invoke(() => JSON.stringify(args, null, 2), ''))), 0, 0));
        const tool = { renderCall: (args, theme) => renderArguments(args, theme) };`,
      errors: [error],
    },
    {
      name: "current submittedValue null fallback",
      code: `${imports}
        const submittedValue = <Args>(args: Args, theme: Theme) =>
          new Text(theme.fg('toolOutput', stripTerminalControls(JSON.stringify(args ?? null, null, 2))), 0, 0);
        const expandedContent = { renderCall: (args, theme) => submittedValue(args, theme) };`,
      errors: [error],
    },
    {
      name: "declared helper and block callback with serialized const",
      code: `${imports}
        function body(values, theme) {
          const raw = invokeHostCallback(() => { const json = JSON.stringify(values); return json ?? ''; }, '');
          return new Text(stripTerminalControls(raw), 0, 0);
        }
        const tool = { renderCall(args, theme) { return body(args, theme); } };`,
      errors: [error],
    },
    {
      name: "a selected branch still renders exact arguments",
      code: `${imports} const tool = { renderCall(args) { const text = stripTerminalControls(JSON.stringify(args)); return new Text(expanded ? text : 'Arguments', 0, 0); } };`,
      errors: [error],
    },
    {
      name: "the last sequence operand still renders exact arguments",
      code: `${imports} const tool = { renderCall(args) { return new Text((notify(), stripTerminalControls(JSON.stringify(args))), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "type syntax does not obscure value flow",
      code: `${imports} const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify((args satisfies Input)!)); } };`,
      errors: [error],
    },
  ],
});
