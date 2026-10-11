import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RuleTester } from "oxlint/plugins-dev";

import { knownHelpers, noEscapingRenderContextRule } from "./no-escaping-render-context.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "escapingRenderContext" };
const rendererFile = "/repo/packages/pi-code-previews/src/tools/renderers/edit.ts";
const nativeFile = "/repo/packages/pi-code-previews/src/tools/native-codemode-render.ts";

const headingImport = "import { stateHeading } from './shared/state-heading';";
const cacheImport = "import { cachedDeferredPreview, cachedPreview } from './shared/cache';";
const componentImport = "import { composeToolComponent } from 'pi-cosmic-ui/tool';";
const safeContentImport = "import { safeContent } from './native-safe-content';";

const validRenderer = (code: string) => ({ filename: rendererFile, code });
const invalidRenderer = (code: string) => ({ filename: rendererFile, code, errors: [error] });

tester.run("anti-slop/no-escaping-render-context", noEscapingRenderContextRule, {
  valid: [
    // Current edit/write patterns capture fields before constructing retained callbacks.
    validRenderer(`${headingImport}
      const tool = { renderCall(args, theme, renderContext) {
        const { state, expanded, invalidate } = renderContext;
        const heading = stateHeading(() => state.summary);
        consume(renderContext.args, expanded, invalidate);
        return heading;
      } };`),
    validRenderer(`${cacheImport}
      const tool = { renderResult(result, options, theme, renderContext) {
        const { invalidate } = renderContext;
        const state = renderContext.state;
        const render = () => renderDiff(result, invalidate);
        return cachedDeferredPreview(state, 'result', [], 100, 'Loading', theme, render, invalidate);
      } };`),
    `${componentImport}
      const tool = { renderCall(args, theme, context) {
        const { state, executionStarted, isPartial } = context;
        return composeToolComponent(() => executionStarted && isPartial ? [state.subject] : []);
      } };`,
    // Reading a property as an argument does not itself retain the context.
    validRenderer(`${cacheImport}
      const tool = { renderCall(args, theme, context) {
        return cachedDeferredPreview(context.state, 'call', [], 100, 'Loading', theme,
          () => new Text(args.text), context.invalidate);
      } };`),
    validRenderer(`${headingImport}
      const tool = { renderCall(args, theme, context) {
        const alias = context;
        const { state: retainedState } = alias;
        const expanded = alias.expanded;
        return stateHeading(() => expanded ? retainedState.full : retainedState.short);
      } };`),
    // Immediate callbacks, including the current background-task result renderer, are safe.
    `import * as Option from 'effect/Option';
      const tool = { renderResult(result, options, theme, context) {
        const details = result.pipe(Option.filter(decoded => decoded.action === context.args.action));
        context.state.subject = Option.match(details, {
          onNone: () => '', onSome: decoded => label(decoded, context.args),
        });
        return Option.map(details, decoded => new Text(label(decoded, context.args)));
      } };`,
    `const tool = { renderCall(args, theme, context) {
      const read = () => context.state.summary;
      return new Text(read());
    } };`,
    `const tool = { renderCall(args, theme, context) {
      return (() => new Text(context.args.text))();
    } };`,
    `import { invokeHostCallback } from 'pi-cosmic-core';
      const tool = { renderCall(args, theme, context) {
        return invokeHostCallback(() => new Text(context.args.text), 'fallback');
      } };`,
    {
      filename: nativeFile,
      code: `${safeContentImport}
        const tool = { renderResult(result, options, theme, context) {
          return safeContent(() => new Text(context.args.text), 'fallback');
        } };`,
    },
    validRenderer(`import { renderWithBorderSlot } from '../../preview/bordered-tool-call';
      const tool = { renderCall(args, theme, context) {
        return renderWithBorderSlot(context.state, 'call', () => new Text(context.args.text));
      } };`),
    validRenderer(`${cacheImport}
      const tool = { renderCall(args, theme, context) {
        return cachedPreview(context.state, 'call', [], () => new Text(context.args.text));
      } };`),
    // Scope identity, not the name 'context', identifies retained renderer input.
    `${componentImport}
      function helper(context) { return composeToolComponent(() => [context.value]); }`,
    `${componentImport}
      const tool = { renderCall(args, theme, context) {
        return composeToolComponent((context) => [context.state]);
      } };`,
    `${componentImport}
      const tool = { renderCall(args, theme, context) {
        const read = () => { const context = { state: 'local' }; return [context.state]; };
        return composeToolComponent(read);
      } };`,
    validRenderer(`${headingImport}
      const tool = { renderCall(args, theme, context) {
        const alias = context;
        return stateHeading(() => { const alias = { state: 'local' }; return alias.state; });
      } };`),
    `${componentImport}
      const tool = { renderCall(args, theme, { state }) {
        return composeToolComponent(() => [state.subject]);
      } };`,
    `${componentImport}
      const tool = { renderCall(args, theme, context) {
        function draw() { return [context.state.summary]; }
        draw = () => [];
        return composeToolComponent(draw);
      } };`,
    // Same-file helpers that receive the context keep only what they read.
    `${componentImport}
      function heading(theme, state) { return composeToolComponent(() => [state.summary]); }
      const tool = { renderCall(args, theme, context) { return heading(theme, context.state); } };`,
    `${componentImport}
      function heading(theme, context) {
        const { state } = context;
        return composeToolComponent(() => [state.summary]);
      }
      const tool = { renderCall(args, theme, context) { return heading(theme, context); } };`,
    // A detached copy does not carry the original's lastComponent chain.
    `${componentImport}
      const tool = { renderCall(args, theme, context) {
        const detached = { ...context, lastComponent: undefined };
        return composeToolComponent(() => [detached.state.summary]);
      } };`,
    // Unknown or shadowed helper contracts are deliberately not inferred by name.
    `const stateHeading = callback => callback();
      const tool = { renderCall(args, theme, context) {
        return stateHeading(() => context.state.summary);
      } };`,
    `import { composeToolComponent } from './unrelated';
      const tool = { renderCall(args, theme, context) {
        return composeToolComponent(() => [context.state]);
      } };`,
    validRenderer(`${headingImport}
      const tool = { renderCall(args, theme, context) {
        const stateHeading = callback => new Text(callback());
        return stateHeading(() => context.state.summary);
      } };`),
    {
      filename: "/repo/packages/other/src/renderers/edit.ts",
      code: `${headingImport}
        const tool = { renderCall(args, theme, context) {
          return stateHeading(() => context.state.summary);
        } };`,
    },
    `${componentImport}
      const tool = { renderCall(args, theme, context) {
        return other.build(() => context.state.summary);
      } };`,
    `import * as Tool from 'pi-cosmic-ui/tool';
      const composeToolComponent = 'immediate';
      const tool = { renderCall(args, theme, context) {
        return Tool[composeToolComponent](() => [context.state.summary]);
      } };`,
    `const tool = { renderCall(args, theme, context) {
      const temporary = { render() { return [context.args.text]; }, invalidate() {} };
      consume(temporary.render());
      return new Text('done');
    } };`,
    `const tool = { renderResult(result, options, theme, context) {
      const state = context.state;
      return { render() { return [state.summary]; }, invalidate() {} };
    } };`,
  ],
  invalid: [
    // The state-heading contract must never regress to retaining context instead of state.
    invalidRenderer(`${headingImport}
      const tool = { renderCall(args, theme, renderContext) {
        return stateHeading(() => renderContext.state.editSummaryText);
      } };`),
    // Historical 4bc5d923 write proposal: the deferred outer callback retains the nested reads.
    invalidRenderer(`${cacheImport}
      import { unlessResultDiffShown } from './shared/result-diff';
      const tool = { renderCall(args, theme, renderContext) {
        const preview = () => cachedPreview(
          renderContext.state, 'writeCallPreviewKey', 'writeCallPreviewComponent', [],
          () => renderContentPreview({
            content: args.content, limit: renderContext.expanded ? 0 : 20,
            invalidate: renderContext.invalidate,
          }),
        );
        return unlessResultDiffShown(renderContext.state, preview);
      } };`),
    // Historical 6801323c background-task heading retained state and flags through context.
    {
      code: `${componentImport}
        const tool = { renderCall(args, theme, context) {
          return composeToolComponent(width => {
            const subtitle = headingSubtitle(args, context.state.backgroundTaskSubject);
            return context.executionStarted && context.isPartial ? [subtitle] : [];
          });
        } };`,
      errors: [error],
    },
    // Historical deferred result callbacks were separately declared, not inline arguments.
    invalidRenderer(`${cacheImport}
      const tool = { renderResult(result, { expanded }, theme, renderContext) {
        const render = () => renderDiff(result, expanded, theme, renderContext.invalidate);
        return cachedDeferredPreview(renderContext.state, 'result', [], 100, 'Loading', theme,
          render, renderContext.invalidate);
      } };`),
    invalidRenderer(`${cacheImport}
      const tool = { renderResult(result, options, theme, context) {
        const render = () => new Diff({ invalidate: context.invalidate });
        const renderAlias = render;
        return cachedDeferredPreview(context.state, 'result', [], 100, 'Loading', theme,
          renderAlias, context.invalidate);
      } };`),
    invalidRenderer(`${headingImport}
      const tool = { renderCall(args, theme, context) {
        const first = context;
        const alias = (first as RenderContext);
        return stateHeading(() => alias.state.summary);
      } };`),
    invalidRenderer(`${headingImport}
      const tool = { renderCall(args, theme, context) {
        return stateHeading(() => { const alias = context; return alias.state.summary; });
      } };`),
    {
      code: `${componentImport}
        const tool = { renderCall: (args, theme, context) =>
          composeToolComponent(() => [context.state.summary]) };`,
      errors: [error],
    },
    {
      code: `${componentImport}
        function renderCall(args, theme, context) {
          function draw() { return [context.state.summary]; }
          return composeToolComponent(draw);
        }
        const tool = { renderCall };`,
      errors: [error],
    },
    {
      code: `import { composeToolComponent as component } from 'pi-cosmic-ui/tool';
        const renderer = (args, theme, context) => component(() => [context.state.summary]);
        const alias = renderer;
        const tool = { renderCall: alias };`,
      errors: [error],
    },
    {
      code: `import * as Tool from 'pi-cosmic-ui/tool';
        const tool = { renderResult(result, options, theme, context) {
          return Tool.composeToolComponent(() => [context.args.text]);
        } };`,
      errors: [error],
    },
    {
      code: `${componentImport}
        const component = composeToolComponent;
        const tool = { renderCall(args, theme, context) {
          return component(() => [context.args.text]);
        } };`,
      errors: [error],
    },
    invalidRenderer(`import { DeferredPreview } from '../../preview/deferred';
      const tool = { renderCall(args, theme, context) {
        return new DeferredPreview('Loading', theme, () => new Text(context.args.text),
          context.invalidate);
      } };`),
    invalidRenderer(`${cacheImport}
      const tool = { renderResult(result, options, theme, context) {
        return cachedDeferredPreview(context.state, 'result', [], 100, 'Loading', theme,
          () => new Text('done'), () => context.invalidate());
      } };`),
    invalidRenderer(`import { deferCodePreview } from '../../application/capability';
      const tool = { renderCall(args, theme, context) {
        deferCodePreview(() => context.invalidate());
        return new Text(args.text);
      } };`),
    invalidRenderer(`import { unlessResultDiffShown } from './shared/result-diff';
      const tool = { renderCall(args, theme, context) {
        return unlessResultDiffShown(context.state, () => new Text(context.args.text));
      } };`),
    // Returned component render methods run later even without a retained-helper call.
    {
      code: `const tool = { renderCall(args, theme, context) {
        return { render(width) { return [context.args.text]; }, invalidate() {} };
      } };`,
      errors: [error],
    },
    {
      code: `const tool = { renderResult: (result, options, theme, context) => ({
        render: width => [context.state.summary], invalidate() {},
      }) };`,
      errors: [error],
    },
    {
      code: `const tool = { renderCall(args, theme, context) {
        const render = width => [context.state.summary];
        const component = { render, invalidate() {} };
        const alias = component;
        return alias;
      } };`,
      errors: [error],
    },
    {
      code: `const tool = { renderCall(args, theme, context) {
        return { render() { return []; }, invalidate() { context.invalidate(); } };
      } };`,
      errors: [error],
    },
    // Immediate construction is not an exemption for the returned component's later methods.
    {
      filename: nativeFile,
      code: `${safeContentImport}
        const tool = { renderResult(result, options, theme, context) {
          return safeContent(() => ({
            render(width) { return [getCodePreviewAnimationFrame(context)]; }, invalidate() {},
          }), 'fallback');
        } };`,
      errors: [error],
    },
    {
      code: `import { invokeHostCallback } from 'pi-cosmic-core';
        const tool = { renderCall(args, theme, context) {
          return invokeHostCallback(() => ({ render: () => [context.args.text] }), 'fallback');
        } };`,
      errors: [error],
    },
    invalidRenderer(`import { renderWithBorderSlot } from '../../preview/bordered-tool-call';
      const tool = { renderCall(args, theme, context) {
        return renderWithBorderSlot(context.state, 'call', () => ({
          render: () => [context.args.text], invalidate() {},
        }));
      } };`),
    invalidRenderer(`${cacheImport}
      const tool = { renderCall(args, theme, context) {
        return cachedPreview(context.state, 'call', [], () => ({ render: () => [context.args.text] }));
      } };`),
    {
      code: `const tool = { renderCall(args, theme, context) {
        return (() => ({ render: () => [context.args.text] }))();
      } };`,
      errors: [error],
    },
    // A same-file helper given the whole context is checked like the renderer itself.
    {
      code: `${componentImport}
        function heading(theme, context) {
          return composeToolComponent(() => [context.state.summary]);
        }
        const tool = { renderCall(args, theme, context) { return heading(theme, context); } };`,
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
    // Closures share their scope, so an escaping component keeps every capture made there.
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

// createOnce state must not carry admitted helpers, renderer bindings, or components into another file.
tester.run("anti-slop/no-escaping-render-context-file-reset", noEscapingRenderContextRule, {
  valid: [
    validRenderer(`const stateHeading = callback => new Text(callback());
      const tool = { renderCall(args, theme, context) {
        return stateHeading(() => context.state.summary);
      } };`),
    `const tool = { renderCall(args, theme, context) { return new Text(context.args.text); } };`,
  ],
  invalid: [],
});

// Linting each definition verifies the table, and a moved or deleted definition fails here.
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
      name: "a value argument that became a callback",
      filename: "/repo/packages/pi-code-previews/src/tools/native-safe-content.ts",
      code: `export function safeContent(build: () => Component, fallback: () => Component): Component {
        return build() ?? fallback();
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
