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
    `${imports} const tool = { renderCall(args) { return new Text(stripTerminalControls(JSON.stringify(args.action)), 0, 0); } };`,
    `${imports} const report = (ctx, message) => ctx.ui.notify(stripTerminalControls(message), 'error');`,
  ],
  invalid: [
    {
      name: "direct renderer input",
      code: `${imports} const tool = { renderCall(input) { return new Text(stripTerminalControls(JSON.stringify(input, null, 2)), 0, 0); } };`,
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
      name: "stripped result text styled as tool output",
      code: `${imports} const renderers = { renderResult(result, options, theme) { const text = getTextContent(result.content); return new Text(theme.fg('toolOutput', stripTerminalControls(text)), 0, 0); } };`,
      errors: [error],
    },
    {
      name: "stripAnsi leaves other controls and still drops visible evidence",
      code: `import { stripAnsi } from 'pi-cosmic-core'; const body = (theme, text) => theme.fg('toolOutput', stripAnsi(text));`,
      errors: [{ messageId: "lossyText", data: { name: "stripAnsi" } }],
    },
    {
      name: "raw serialized arguments styled as tool output",
      code: `${imports} const tool = { renderCall(args, theme) { return new Text(theme.fg('toolOutput', JSON.stringify(args, null, 2)), 0, 0); } };`,
      errors: [unescaped],
    },
  ],
});
