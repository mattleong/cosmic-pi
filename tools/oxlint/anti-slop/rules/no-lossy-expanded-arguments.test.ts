import { RuleTester } from "oxlint/plugins-dev";

import { noLossyExpandedArgumentsRule } from "./no-lossy-expanded-arguments.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const imports = `
  import { Text } from '@earendil-works/pi-tui';
  import { stripTerminalControls, invokeHostCallback } from 'pi-cosmic-core';
`;
const error = { messageId: "lossyText" };
const unescaped = { messageId: "unescapedArguments" };

tester.run("anti-slop/no-lossy-expanded-arguments", noLossyExpandedArgumentsRule, {
  valid: [
    `${imports} const tool = { renderCall(args, theme) { return expandedArguments(theme, args); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(escapeControlChars(JSON.stringify(args)), 0, 0); } };`,
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
    `import { stripTerminalControls } from './security'; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args) { const stripTerminalControls = (text) => text; return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args, JSON) { return new Text(stripTerminalControls(JSON.stringify(args)), 0, 0); } };`,
    `${imports} const JSON = { stringify(value) { return value; } }; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args) { const invokeHostCallback = (f) => f(); return stripTerminalControls(invokeHostCallback(() => JSON.stringify(args))); } };`,
    `import type { stripTerminalControls } from 'pi-cosmic-core'; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `import { type stripTerminalControls } from 'pi-cosmic-core'; const tool = { renderCall(args) { return stripTerminalControls(JSON.stringify(args)); } };`,
    `${imports} const tool = { renderCall(args) { const raw = format(JSON.stringify(args)); return stripTerminalControls(raw); } };`,
    `${imports} const tool = { renderCall(args) { let raw = JSON.stringify(args); raw = 'summary'; return stripTerminalControls(raw); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(JSON.stringify(args.action)), 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { const { action } = args; return new Text(stripTerminalControls(JSON.stringify(action)), 0, 0); } };`,
    `${imports} const tool = { compactSummary: ({ args }) => ({ subject: stripTerminalControls(args.title) }) };`,
    `${imports} const issue = (message, line) => ({ severity: 'warning', message: line, detail: stripTerminalControls(message) });`,
    `${imports} const report = (ctx, message) => ctx.ui.notify(stripTerminalControls(message), 'error');`,
    `${imports} const tool = { renderResult(result, options, theme) { return new Text(theme.fg('muted', stripTerminalControls(getTextContent(result.content))), 0, 0); } };`,
    `${imports} const settingsError = (theme, message) => new Text(theme.fg('error', stripTerminalControls(message)), 0, 0);`,
    `${imports} const tool = { renderResult(result, options, theme) { return new Text(theme.fg('toolOutput', escapeControlChars(getTextContent(result.content))), 0, 0); } };`,
    `${imports} const tool = { renderResult(result, options, theme) { const raw = getTextContent(result.content); const text = stripTerminalControls(raw); return new Text(theme.fg('toolOutput', text === raw ? raw : escapeControlChars(raw)), 0, 0); } };`,
    `${imports} const stripAnsi = (text) => text; const body = (theme, text) => theme.fg('toolOutput', stripAnsi(text));`,
    `import { stripAnsi } from './support/render'; const body = (theme, text) => theme.fg('toolOutput', stripAnsi(text));`,
    `${imports} const body = (theme, text) => theme.fg(stripTerminalControls(text), text);`,
    `${imports} const tool = { renderResult(result) { return new Text(JSON.stringify(result.details), 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { return new Text(JSON.stringify(args).length > 80 ? 'Large input' : 'Small input', 0, 0); } };`,
    `${imports} const tool = { renderCall(args) { console.log(JSON.stringify(args)); return new Text('ok', 0, 0); } };`,
    `${imports} const tool = { compactSummary: ({ args }) => ({ subject: JSON.stringify(args) }) };`,
    `${imports} const call = (args) => new Text(JSON.stringify(args), 0, 0);`,
    `${imports} const tool = { renderCall(args, theme) { return new Text(theme.fg('toolOutput', escapeControlChars(JSON.stringify(args, null, 2))), 0, 0); } };`,
    {
      filename: "/repo/packages/pi-owner/tests/tools/fake-renderer.test.ts",
      code: `${imports} const fake = { renderCall: (args) => new Text(JSON.stringify(args), 0, 0), renderResult: (result, options, theme) => new Text(theme.fg('toolOutput', stripTerminalControls(text)), 0, 0) };`,
    },
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
    {
      name: "stripped result text styled as tool output",
      code: `${imports} const renderers = { renderResult(result, options, theme) { const text = getTextContent(result.content); return new Text(theme.fg('toolOutput', stripTerminalControls(text)), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "aliased sanitizer in a shared expanded-content helper",
      code: `import { Text } from '@earendil-works/pi-tui';
        import { stripTerminalControls as sanitizeTerminalText } from 'pi-cosmic-core';
        export const renderInput = (input, theme) =>
          new Text(theme.fg('toolOutput', sanitizeTerminalText(input.lines.join('\\n'))), 0, 0);`,
      errors: [error],
    },
    {
      name: "stripped text selected through const aliases",
      code: `${imports}
        const content = {
          renderResult: (result, options, theme, context) => {
            const text = stripTerminalControls(getTextContent(result.content));
            if (context.isError) return errorSection(theme, text);
            const shown = replied ? text : '';
            return new Text(theme.fg('toolOutput', shown), 0, 0);
          },
        };`,
      errors: [error],
    },
    {
      name: "stripAnsi leaves other controls and still drops visible evidence",
      code: `import { stripAnsi } from 'pi-cosmic-core'; const body = (theme, text) => theme.fg('toolOutput', stripAnsi(text));`,
      errors: [{ messageId: "lossyText", data: { name: "stripAnsi" } }],
    },
    {
      name: "error-styled renderer output",
      code: `${imports} const tool = { renderResult(result, options, theme) { return new Text(theme.fg('error', stripTerminalControls(getTextContent(result.content))), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "error-styled output in a renderer bound by shorthand",
      code: `${imports} const renderResult = (result, options, theme) => [theme.fg('error', stripTerminalControls(text))]; const tool = { renderResult };`,
      errors: [error],
    },
    {
      name: "template and nested styling keep the stripped text",
      code: `${imports} const line = (theme, text) => theme.fg('toolOutput', theme.bold(\`Reply: \${stripTerminalControls(text)}\`));`,
      errors: [error],
    },
    {
      name: "raw serialized arguments in a fallback renderer",
      code: `${imports}
        function nativeBackground(name, downstream) {
          const call = downstream?.renderCall ??
            ((args, theme) => new Text(\`\${theme.fg('toolTitle', theme.bold(name))}\\n\${JSON.stringify(args, null, 2)}\`, 0, 0));
          return { renderShell: 'self', renderCall: call };
        }`,
      errors: [unescaped],
    },
    {
      name: "raw serialized arguments styled as tool output",
      code: `${imports} const tool = { renderCall(args, theme) { return new Text(theme.fg('toolOutput', JSON.stringify(args, null, 2)), 0, 0); } };`,
      errors: [unescaped],
    },
    {
      name: "raw serialized arguments through invokeHostCallback",
      code: `${imports} const tool = { renderCall(args) { return new Text(invokeHostCallback(() => JSON.stringify(args), ''), 0, 0); } };`,
      errors: [unescaped],
    },
    {
      name: "raw serialized arguments concatenated into a label",
      code: `${imports} const tool = { renderCall(args) { return new Text('Arguments: ' + JSON.stringify(args), 0, 0); } };`,
      errors: [unescaped],
    },
  ],
});
