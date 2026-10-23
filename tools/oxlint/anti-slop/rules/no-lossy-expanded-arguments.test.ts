import { RuleTester } from "oxlint/plugins-dev";

import { noLossyExpandedArgumentsRule } from "./no-lossy-expanded-arguments.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const imports = `
  import { Text } from '@earendil-works/pi-tui';
  import { stripTerminalControls, invokeHostCallback } from 'pi-cosmic-core';
`;
const narrowImports = `
  import { Text } from '@earendil-works/pi-tui';
  import { stripTerminalControls as strip, stripAnsi } from 'pi-cosmic-core/security';
  import { invokeHostCallback as invoke } from 'pi-cosmic-core/host-session';
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
    `${narrowImports} const tool = { renderCall(args) {
      return new Text(escapeControlChars(invoke(() => JSON.stringify(args), '')), 0, 0);
    } };`,
    `${narrowImports} const report = (ctx, message) => ctx.ui.notify(strip(message), 'error');`,
    `${narrowImports} function body(theme, text, stripAnsi) {
      return theme.fg('toolOutput', stripAnsi(text));
    }`,
    `import { stripTerminalControls } from 'pi-cosmic-core/security/custom';
      const body = (theme, text) => theme.fg('toolOutput', stripTerminalControls(text));`,
    `import { invokeHostCallback } from 'pi-cosmic-core/host-session/custom';
      const tool = { renderCall(args) { return invokeHostCallback(() => JSON.stringify(args), ''); } };`,
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
    {
      name: "narrow aliased sanitizer and callback preserve argument tracking",
      code: `${narrowImports} const tool = { renderCall(args) {
        return new Text(strip(invoke(() => JSON.stringify(args), '')), 0, 0);
      } };`,
      errors: [error],
    },
    {
      name: "narrow namespace sanitizer preserves output tracking through an alias",
      code: `import * as Security from 'pi-cosmic-core/security';
        const strip = Security.stripTerminalControls;
        const body = (theme, text) => theme.fg('toolOutput', strip(text));`,
      errors: [error],
    },
    {
      name: "narrow stripAnsi still loses expanded error evidence",
      code: `${narrowImports} const tool = { renderResult(result, options, theme) {
        return new Text(theme.fg('error', stripAnsi(result.text)), 0, 0);
      } };`,
      errors: [{ messageId: "lossyText", data: { name: "stripAnsi" } }],
    },
    {
      name: "narrow aliased callback keeps raw serialization unescaped",
      code: `${narrowImports} const tool = { renderCall(args) {
        return invoke(() => JSON.stringify(args), '');
      } };`,
      errors: [unescaped],
    },
    {
      name: "narrow namespace callback keeps raw serialization unescaped",
      code: `import * as Host from 'pi-cosmic-core/host-session';
        const invoke = Host.invokeHostCallback;
        const tool = { renderCall(args) { return invoke(() => JSON.stringify(args), ''); } };`,
      errors: [unescaped],
    },
  ],
});
