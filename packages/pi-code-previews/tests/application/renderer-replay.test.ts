import assert from "node:assert/strict";
import {
  initTheme,
  ToolExecutionComponent,
  type ToolInfo,
  type ToolRendererResolver,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, afterEach, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { makePiManagedRuntime } from "pi-cosmic-core";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../../src/application/tool-renderers";
import { retainedCodePreviewRenderers } from "../../src/application/renderer-row";
import {
  codePreviewsWithDependencies,
  type CodePreviewExtensionDependencies,
} from "../../src/application/lifecycle";
import { clearCodePreviewSessionCapability } from "../../src/application/capability";
import { codePreviewApplicationLayer } from "../../src/layer";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { renderContextFixture } from "../../testing";
import type { CodePreviewSettings } from "../../src/config/schema";
import { createBuiltinPreviewRenderers } from "../../src/tools/renderers/registration";
import { step } from "../support/effect-test";

beforeAll(() => initTheme("dark", false));
afterEach(() => {
  clearCodePreviewSessionCapability();
  setCodePreviewSettings(defaultCodePreviewSettings);
});
const info = (name: string): ToolInfo => ({
  name,
  description: name,
  parameters: opaqueFixture({}),
  exposure: "direct",
  sourceInfo: {
    source: "builtin",
    path: `builtin:${name}`,
    scope: "temporary",
    origin: "top-level",
  },
});
const output = {
  content: [{ type: "text" as const, text: "COMPLETE RETAINED OUTPUT" }],
  details: {},
  isError: false,
};
const downstream: ToolRenderers = {
  renderCall: () => new Text("NATIVE CALL CONTENT", 0, 0),
  renderResult: () => new Text("NATIVE RESULT CONTENT", 0, 0),
};
const scheduler = { defer: () => () => undefined, schedule: () => () => undefined };
type ReplayArguments = { command: string } | { code: string };
const hostRow = (
  renderers: ToolRenderers | undefined,
  name = "bash",
  args: ReplayArguments = { command: "echo EXACT_SOURCE" },
) =>
  new ToolExecutionComponent(
    name,
    "replay",
    args,
    { showImages: false },
    renderers,
    opaqueFixture({ requestRender() {} }),
    "/project",
  );

for (const name of ["bash", "codemode"] as const)
  for (const discovery of ["empty", "error"] as const)
    for (const admission of ["native", "foreign", "missing", "error"] as const) {
      it(`cold ${name} replay survives ${discovery} metadata then ${admission} readiness`, () => {
        let metadata: ToolInfo[] = [];
        let broken = discovery === "error";
        const pi = extensionApiFixture({
          getAllTools: () => {
            if (broken) throw new Error("public metadata not bound");
            return metadata;
          },
          getCommands: () => [],
        });
        const owner = new CodePreviewPresentationOwner();
        const resolver = createCodePreviewRendererResolver(pi, () => owner, new Set());
        const renderers = resolver(name, () => downstream);
        assert.equal(renderers?.renderShell, "self");
        const row = hostRow(
          renderers,
          name,
          name === "bash" ? { command: "echo EXACT_SOURCE" } : { code: "text('EXACT_SOURCE');" },
        );
        row.updateResult(output);
        assert.match(row.render(100).join("\n"), /NATIVE RESULT CONTENT/);
        broken = admission === "error";
        if (admission === "native") metadata = [info(name)];
        if (admission === "foreign")
          metadata = [
            { ...info(name), sourceInfo: { ...info(name).sourceInfo, source: "foreign" } },
          ];
        setCodePreviewSettings({
          ...defaultCodePreviewSettings,
          syntaxHighlighting: false,
          toolCallTiming: false,
          toolCallCollapsedStyle: "compact",
          toolCallBackground: "border",
          tools: [name],
        });
        owner.publish("/project", new Set([name]), scheduler);
        row.setExpanded(true);
        row.invalidate();
        const rendered = row.render(100).join("\n");
        if (admission === "native") {
          assert.match(rendered, /EXACT_SOURCE/);
          assert.match(rendered, /COMPLETE RETAINED OUTPUT/);
          assert.doesNotMatch(rendered, /NATIVE RESULT CONTENT/);
        } else {
          assert.match(rendered, /NATIVE CALL CONTENT/);
          assert.match(rendered, /NATIVE RESULT CONTENT/);
        }
        owner.retire();
      });
    }

for (const style of ["preview", "compact"] as const)
  for (const mode of ["on", "off", "border"] as const) {
    it(`a real retained host row adopts first-ready ${style}/${mode} with complete call and result`, () => {
      const owner = new CodePreviewPresentationOwner();
      const pi = extensionApiFixture({ getAllTools: () => [info("bash")], getCommands: () => [] });
      const resolver = createCodePreviewRendererResolver(pi, () => owner, new Set());
      // Exactly one resolver evaluation: this is Pi's replay construction boundary.
      const renderers = resolver("bash", () => downstream);
      assert.equal(renderers?.renderShell, "self");
      const row = hostRow(renderers);
      row.updateResult(output);
      assert.match(row.render(80).join("\n"), /NATIVE CALL CONTENT/);
      assert.match(row.render(80).join("\n"), /NATIVE RESULT CONTENT/);
      setCodePreviewSettings({
        ...defaultCodePreviewSettings,
        syntaxHighlighting: false,
        toolCallTiming: false,
        toolCallCollapsedStyle: style,
        toolCallBackground: mode,
        tools: ["bash"],
      });
      owner.publish("/project", new Set(["bash"]), scheduler);
      for (const expanded of [true, false, true]) {
        row.setExpanded(expanded);
        row.invalidate();
        const rendered = row.render(80).join("\n");
        assert.match(rendered, /EXACT_SOURCE/);
        if (expanded || style === "preview") assert.match(rendered, /COMPLETE RETAINED OUTPUT/);
        assert.doesNotMatch(rendered, /NATIVE RESULT CONTENT/);
      }
      // Mouse-driven host expansion still reaches the retained facade.
      row.setExpanded(false);
      row.render(80);
      const mouse = row.handleMouse(
        opaqueFixture({ type: "click", button: "left", x: 2, y: 1, width: 80, height: 20 }),
      );
      assert.equal(mouse?.handled, true);
      assert.match(row.render(80).join("\n"), /COMPLETE RETAINED OUTPUT/);
      owner.retire();
    });
  }

it("lazy draw adoption refeeds stored result without host refresh or execution events", () => {
  const owner = new CodePreviewPresentationOwner();
  const context = renderContextFixture({
    args: { command: "echo EXACT_SOURCE" },
    expanded: true,
    isPartial: false,
    invalidate() {},
  });
  const renderers = retainedCodePreviewRenderers(
    "bash",
    downstream,
    owner,
    () => owner.session && createBuiltinPreviewRenderers("bash", owner.session),
  );
  const call = renderers.renderCall!(context.args, plainTheme, context);
  const result = renderers.renderResult!(
    output,
    { expanded: true, isPartial: false },
    plainTheme,
    context,
  );
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "border",
    tools: ["bash"],
  });
  owner.publish("/project", new Set(["bash"]), scheduler);
  const rendered = [...call.render(80), ...result.render(80)].join("\n");
  assert.match(rendered, /EXACT_SOURCE/);
  assert.match(rendered, /COMPLETE RETAINED OUTPUT/);
  owner.retire();
});

it("cold and declined rows preserve independent downstream caches and live panel state", () => {
  const owner = new CodePreviewPresentationOwner();
  const pi = extensionApiFixture({ getAllTools: () => [info("bash")], getCommands: () => [] });
  const panels: ToolRenderers = {
    renderCall: (_args, _theme, context) => {
      assert.ok(context.lastComponent === undefined || context.lastComponent instanceof Text);
      const panel = context.lastComponent ?? new Text("", 0, 0);
      panel.setText(context.state.resultWasSeen ? "CALL SAW OUTPUT" : "WAITING");
      return panel;
    },
    renderResult: (_value, _options, _theme, context) => {
      assert.ok(context.lastComponent === undefined || context.lastComponent instanceof Text);
      context.state.resultWasSeen = true;
      const panel = context.lastComponent ?? new Text("", 0, 0);
      panel.setText("RESULT PANEL");
      return panel;
    },
  };
  const resolver = createCodePreviewRendererResolver(pi, () => owner, new Set());
  const row = hostRow(resolver("bash", () => panels));
  row.updateResult(output);
  row.invalidate();
  assert.match(row.render(80).join("\n"), /CALL SAW OUTPUT/);
  // Disabled preview selection must not erase the downstream renderer's live state.
  owner.publish("/project", new Set(), scheduler);
  row.setExpanded(true);
  assert.match(row.render(80).join("\n"), /CALL SAW OUTPUT/);
  assert.match(row.render(80).join("\n"), /RESULT PANEL/);
  owner.retire();
});

for (const close of ["replacement", "shutdown"] as const)
  it(`retired replay rows never adopt the ${close} owner's settings`, () => {
    let owner = new CodePreviewPresentationOwner();
    const pi = extensionApiFixture({ getAllTools: () => [info("bash")], getCommands: () => [] });
    const resolver = createCodePreviewRendererResolver(pi, () => owner, new Set());
    const old = hostRow(resolver("bash", () => downstream));
    old.updateResult(output);
    owner.retire();
    owner = new CodePreviewPresentationOwner();
    setCodePreviewSettings({
      ...defaultCodePreviewSettings,
      syntaxHighlighting: false,
      toolCallTiming: false,
      toolCallCollapsedStyle: "compact",
      toolCallBackground: "border",
      tools: ["bash"],
    });
    owner.publish("/replacement", new Set(["bash"]), scheduler);
    old.invalidate();
    old.setExpanded(true);
    assert.match(old.render(80).join("\n"), /NATIVE RESULT CONTENT/);
    const fresh = hostRow(resolver("bash", () => downstream));
    fresh.updateResult(output);
    fresh.setExpanded(true);
    assert.match(fresh.render(80).join("\n"), /COMPLETE RETAINED OUTPUT/);
    owner.retire();
  });

effectIt.effect(
  "factory replay stays native through pending and failed settings, then only new rows adopt replacement",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, (event: never, ctx: never) => void | Promise<void>>();
      const resolvers: ToolRendererResolver[] = [];
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let loads = 0;
      const pi = extensionApiFixture({
        on: (name: string, handler: (event: never, ctx: never) => void | Promise<void>) =>
          handlers.set(name, handler),
        registerToolRenderer: (resolver: ToolRendererResolver) => resolvers.push(resolver),
        getAllTools: () => [info("bash")],
        getCommands: () => [],
      });
      const settings: CodePreviewSettings = {
        ...defaultCodePreviewSettings,
        syntaxHighlighting: false,
        toolCallTiming: false,
        toolCallCollapsedStyle: "compact" as const,
        tools: ["bash"],
      };
      const deps: CodePreviewExtensionDependencies = {
        makeRuntime: (host) => makePiManagedRuntime(host, codePreviewApplicationLayer),
        registerCommands() {},
        registerRenderers() {},
        initializeSyntax: () => Effect.void,
        loadSettings: () =>
          loads++ === 0
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("settings failed")),
              )
            : Effect.sync(() => {
                setCodePreviewSettings(settings);
                return settings;
              }),
      };
      yield* step(() => codePreviewsWithDependencies(pi, deps));
      const context = extensionContextFixture({
        cwd: "/project",
        isProjectTrusted: () => true,
        ui: { notify() {} },
      });
      const dispatch = (name: string) =>
        Promise.resolve(handlers.get(name)?.(opaqueFixture({}), opaqueFixture(context)));
      const row = hostRow(resolvers[0]!("bash", () => downstream));
      row.updateResult(output);
      const starting = dispatch("session_start");
      yield* Deferred.await(entered);
      assert.match(row.render(80).join("\n"), /NATIVE RESULT CONTENT/);
      yield* Deferred.succeed(release, undefined);
      yield* step(() => starting);
      yield* step(() => dispatch("session_start"));
      assert.equal(resolvers.length, 1);
      row.invalidate();
      assert.match(row.render(80).join("\n"), /NATIVE RESULT CONTENT/);
      const fresh = hostRow(resolvers[0]!("bash", () => downstream));
      fresh.updateResult(output);
      fresh.setExpanded(true);
      assert.match(fresh.render(80).join("\n"), /COMPLETE RETAINED OUTPUT/);
      yield* step(() => dispatch("session_shutdown"));
    }),
);
