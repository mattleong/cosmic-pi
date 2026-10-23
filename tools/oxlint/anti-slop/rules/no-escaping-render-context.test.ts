import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";

import { knownHelpers, noEscapingRenderContextRule } from "./no-escaping-render-context.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "escapingRenderContext" };
const rendererFile = "/repo/packages/pi-code-previews/src/tools/renderers/edit.ts";

const headingImport = "import { stateHeading } from './shared/state-heading';";
const componentImport = "import { composeToolComponent } from 'pi-cosmic-ui/tool';";

const validRenderer = (code: string) => ({ filename: rendererFile, code });
const invalidRenderer = (code: string) => ({ filename: rendererFile, code, errors: [error] });

tester.run("anti-slop/no-escaping-render-context", noEscapingRenderContextRule, {
  valid: [
    validRenderer(`${headingImport}
      const tool = { renderCall(args, theme, renderContext) {
        const { state, expanded, invalidate } = renderContext;
        const heading = stateHeading(() => state.summary);
        consume(renderContext.args, expanded, invalidate);
        return heading;
      } };`),
    `const tool = { renderCall(args, theme, context) {
      return (() => new Text(context.args.text))();
    } };`,
    `import { invokeHostCallback } from 'pi-cosmic-core';
      const tool = { renderCall(args, theme, context) {
        return invokeHostCallback(() => new Text(context.args.text), 'fallback');
      } };`,
    `${componentImport}
      const tool = { renderCall(args, theme, { state }) {
        return composeToolComponent(() => [state.subject]);
      } };`,
    `const tool = { renderResult(result, options, theme, context) {
      const state = context.state;
      return { render() { return [state.summary]; }, invalidate() {} };
    } };`,
  ],
  invalid: [
    invalidRenderer(`${headingImport}
      const tool = { renderCall(args, theme, renderContext) {
        return stateHeading(() => renderContext.state.editSummaryText);
      } };`),
    {
      code: `${componentImport}
        const tool = { renderCall: (args, theme, context) =>
          composeToolComponent(() => [context.state.summary]) };`,
      errors: [error],
    },
    invalidRenderer(`import { DeferredPreview } from '../../preview/deferred';
      const tool = { renderCall(args, theme, context) {
        return new DeferredPreview('Loading', theme, () => new Text(context.args.text),
          context.invalidate);
      } };`),
    {
      code: `const tool = { renderCall(args, theme, context) {
        return { render(width) { return [context.args.text]; }, invalidate() {} };
      } };`,
      errors: [error],
    },
    {
      name: "historical native MCP heading: a const helper's component, two calls deep",
      code: `const heading = (theme, context) => ({ render: () => [subtitle(context)], invalidate() {} });
        const body = (theme, context) => {
          const container = new Container();
          container.addChild(heading(theme, context));
          return container;
        };
        const tool = { renderResult(result, options, theme, context) {
          return body(theme, context);
        } };`,
      errors: [error],
    },
    {
      name: "historical web-access compose: a failure callback shared the component's scope",
      code: `const tool = { renderCall(args, theme, context) {
          const markFailed = () => failures.set(context.state, true);
          return { render: (width) => guarded(() => body.render(width), markFailed), invalidate() {} };
        } };`,
      errors: [error],
    },
  ],
});

for (const source of ["pi-cosmic-core", "pi-cosmic-core/host-session"]) {
  const hostImport = `import { invokeHostCallback as invoke } from '${source}';`;
  tester.run(`anti-slop/no-escaping-render-context-${source}`, noEscapingRenderContextRule, {
    valid: [
      `${hostImport} const tool = { renderCall(args, theme, context) {
        return invoke(() => new Text(context.args.text), 'fallback');
      } };`,
      `${hostImport} const tool = { renderCall(args, theme, context) {
        const state = context.state;
        return invoke(() => ({ render: () => [state.summary] }), undefined);
      } };`,
      `${hostImport} function makeTool(invoke) {
        return { renderCall(args, theme, context) {
          return invoke(() => ({ render: () => [context.state.summary] }), undefined);
        } };
      }`,
    ],
    invalid: [
      {
        name: "an aliased host callback returns a component retaining context",
        code: `${hostImport} const tool = { renderCall(args, theme, context) {
          return invoke(() => ({ render: () => [context.state.summary] }), undefined);
        } };`,
        errors: [error],
      },
      {
        name: "a namespace host callback's fallback component retains context",
        code: `import * as Host from '${source}';
          const invoke = Host.invokeHostCallback;
          const tool = { renderResult(result, options, theme, context) {
            return invoke(() => new Text('ok'), { render: () => [context.state.summary] });
          } };`,
        errors: [error],
      },
    ],
  });
}

tester.run("anti-slop/no-escaping-render-context-file-reset", noEscapingRenderContextRule, {
  valid: [
    validRenderer(`const stateHeading = callback => new Text(callback());
      const tool = { renderCall(args, theme, context) {
        return stateHeading(() => context.state.summary);
      } };`),
    `const tool = { renderCall(args, theme, context) { return new Text(context.args.text); } };`,
    `import { invokeHostCallback } from 'pi-cosmic-core/host-session/custom';
      const tool = { renderCall(args, theme, context) {
        return invokeHostCallback(() => ({ render: () => [context.state.summary] }), undefined);
      } };`,
  ],
  invalid: [],
});

const packages = fileURLToPath(new URL("../../../../packages/", import.meta.url));
const stale = { messageId: "staleHelper" };
tester.run("anti-slop/no-escaping-render-context-helper-table", noEscapingRenderContextRule, {
  valid: [...new Set(knownHelpers.map((helper) => helper.definition))].map((definition) => ({
    filename: `${packages}${definition}.ts`,
    code: readFileSync(`${packages}${definition}.ts`, "utf8"),
  })),
  invalid: [
    {
      name: "a moved callback parameter",
      filename: "/repo/packages/pi-code-previews/src/tools/renderers/shared/state-heading.ts",
      code: `export function stateHeading(theme: Theme, text: () => string): Component {
        return render(theme, text);
      }`,
      errors: [stale],
    },
    {
      name: "a renamed class",
      filename: "/repo/packages/pi-code-previews/src/preview/deferred.ts",
      code: `export class LazyPreview {
        constructor(message: string, theme: Theme, compute: () => Component, invalidate: () => void) {}
      }`,
      errors: [{ messageId: "missingHelper" }],
    },
  ],
});
