import assert from "node:assert/strict";
import { initTheme, type ToolInfo, type ToolRenderers } from "@earendil-works/pi-coding-agent";
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
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../../src/application/tool-renderers";
import {
  codePreviewsWithDependencies,
  type CodePreviewExtensionDependencies,
} from "../../src/application/lifecycle";
import { clearCodePreviewSessionCapability } from "../../src/application/capability";
import { codePreviewApplicationLayer } from "../../src/layer";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { drawToolRow, hostToolRow, renderContextFixture } from "../../testing";
import type { CodePreviewSettings } from "../../src/config/schema";
import { step } from "../support/effect-test";
import {
  builtinToolInfo as info,
  inertScheduler as scheduler,
  presentationResolver,
  setPlainPreviewSettings,
} from "../support/renderer-host";

beforeAll(() => initTheme("dark", false));
afterEach(() => {
  clearCodePreviewSessionCapability();
  setCodePreviewSettings(defaultCodePreviewSettings);
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
const hostRow = (renderers: ToolRenderers | undefined) =>
  hostToolRow("bash", { command: "echo EXACT_SOURCE" }, renderers, { result: output });

for (const name of ["bash", "codemode", "tool_search"] as const)
  for (const discovery of ["empty", "error"] as const)
    for (const admission of ["native", "foreign", "missing", "error"] as const) {
      it(`cold ${name} replay survives ${discovery} metadata then ${admission} readiness`, () => {
        let metadata: ToolInfo[] = [];
        let broken = discovery === "error";
        const { owner, resolver } = presentationResolver({
          getAllTools: () => {
            if (broken) throw new Error("public metadata not bound");
            return metadata;
          },
        });
        const renderers = resolver(name, () => downstream);
        assert.equal(renderers?.renderShell, "self");
        const row = hostToolRow(
          name,
          name === "bash"
            ? { command: "echo EXACT_SOURCE" }
            : name === "codemode"
              ? { code: "text('EXACT_SOURCE');" }
              : { query: "EXACT_SOURCE" },
          renderers,
          { result: output },
        );
        assert.match(row.render(100).join("\n"), /NATIVE RESULT CONTENT/);
        broken = admission === "error";
        if (admission === "native") metadata = [info(name)];
        if (admission === "foreign")
          metadata = [
            { ...info(name), sourceInfo: { ...info(name).sourceInfo, source: "foreign" } },
          ];
        setPlainPreviewSettings({
          toolCallCollapsedStyle: "compact",
          toolCallBackground: "border",
          tools: [name],
        });
        owner.publish("/project", new Set([name]), scheduler);
        const rendered = drawToolRow(row, true, 100);
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
      const { owner, resolver } = presentationResolver({ getAllTools: () => [info("bash")] });
      // Exactly one resolver evaluation: this is Pi's replay construction boundary.
      const renderers = resolver("bash", () => downstream);
      assert.equal(renderers?.renderShell, "self");
      const row = hostRow(renderers);
      assert.match(row.render(80).join("\n"), /NATIVE CALL CONTENT/);
      assert.match(row.render(80).join("\n"), /NATIVE RESULT CONTENT/);
      setPlainPreviewSettings({
        toolCallCollapsedStyle: style,
        toolCallBackground: mode,
        tools: ["bash"],
      });
      owner.publish("/project", new Set(["bash"]), scheduler);
      for (const expanded of [true, false, true]) {
        const rendered = drawToolRow(row, expanded, 80);
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

for (const style of ["preview", "compact"] as const)
  for (const mode of ["on", "off", "border"] as const)
    it(`retained tool search adopts ${style}/${mode} without borrowing replacement ownership`, () => {
      let owner = new CodePreviewPresentationOwner();
      const first = owner;
      const pi = extensionApiFixture({
        getAllTools: () => [info("tool_search")],
        getCommands: () => [],
      });
      const resolver = createCodePreviewRendererResolver(pi, () => owner, new Set());
      const renderers = resolver("tool_search", () => downstream);
      assert.equal(renderers?.renderShell, "self");
      const row = hostToolRow("tool_search", { query: "EXACT_QUERY", limit: 7 }, renderers, {
        result: { ...output, details: { loaded: ["docs_lookup"] } },
      });
      assert.match(row.render(80).join("\n"), /NATIVE RESULT CONTENT/);
      setCodePreviewSettings({
        ...defaultCodePreviewSettings,
        toolCallTiming: false,
        toolCallCollapsedStyle: style,
        toolCallBackground: mode,
      });
      owner.publish("/first", new Set(["tool_search"]), scheduler);
      for (const expanded of [false, true, false, true]) {
        const rendered = drawToolRow(row, expanded, 80);
        assert.match(rendered, /EXACT_QUERY/);
        assert.doesNotMatch(rendered, /NATIVE RESULT CONTENT/);
        assert.equal(rendered.includes("COMPLETE RETAINED OUTPUT"), expanded);
        if (expanded) assert.match(rendered, /"limit": 7/);
      }
      owner.retire();
      owner = new CodePreviewPresentationOwner();
      setCodePreviewSettings({
        ...defaultCodePreviewSettings,
        tools: [],
        toolCallCollapsedStyle: style === "preview" ? "compact" : "preview",
      });
      let replacementSchedules = 0;
      owner.publish("/replacement", new Set(), {
        ...scheduler,
        schedule: () => {
          replacementSchedules++;
          return () => {};
        },
      });
      row.invalidate();
      assert.match(row.render(80).join("\n"), /COMPLETE RETAINED OUTPUT/);
      assert.equal(first.session?.collapsedStyle, style);
      assert.equal(first.session?.mode, mode);
      assert.equal(replacementSchedules, 0);
      assert.equal(resolver("tool_search", () => downstream)?.renderCall, downstream.renderCall);
      owner.retire();
    });

for (const name of ["bash", "tool_search"] as const)
  it(`lazy ${name} draw adoption refeeds stored result without host refresh or execution events`, () => {
    const context = renderContextFixture({
      args: name === "bash" ? { command: "echo EXACT_SOURCE" } : { query: "EXACT_SOURCE" },
      expanded: true,
      isPartial: false,
      invalidate() {},
    });
    const { owner, resolver } = presentationResolver({ getAllTools: () => [info(name)] });
    const renderers = resolver(name, () => downstream)!;
    const call = renderers.renderCall!(context.args, plainTheme, context);
    const result = renderers.renderResult!(
      output,
      { expanded: true, isPartial: false },
      plainTheme,
      context,
    );
    setPlainPreviewSettings({
      toolCallCollapsedStyle: "compact",
      toolCallBackground: "border",
      tools: [name],
    });
    owner.publish("/project", new Set([name]), scheduler);
    const rendered = [...call.render(80), ...result.render(80)].join("\n");
    assert.match(rendered, /EXACT_SOURCE/);
    assert.match(rendered, /COMPLETE RETAINED OUTPUT/);
    owner.retire();
  });

it("cold and declined rows preserve independent downstream caches and live panel state", () => {
  const { owner, resolver } = presentationResolver({ getAllTools: () => [info("bash")] });
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
  const row = hostRow(resolver("bash", () => panels));
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
    owner.retire();
    owner = new CodePreviewPresentationOwner();
    setPlainPreviewSettings({
      toolCallCollapsedStyle: "compact",
      toolCallBackground: "border",
      tools: ["bash"],
    });
    owner.publish("/replacement", new Set(["bash"]), scheduler);
    old.invalidate();
    old.setExpanded(true);
    assert.match(old.render(80).join("\n"), /NATIVE RESULT CONTENT/);
    const fresh = hostRow(resolver("bash", () => downstream));
    fresh.setExpanded(true);
    assert.match(fresh.render(80).join("\n"), /COMPLETE RETAINED OUTPUT/);
    owner.retire();
  });

effectIt.effect(
  "factory replay stays native through pending and failed settings, then only new rows adopt replacement",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let loads = 0;
      const host = recordingExtensionHost(undefined, {
        getAllTools: () => [info("bash")],
        getCommands: () => [],
      });
      const resolvers = host.toolRenderers;
      const settings: CodePreviewSettings = {
        ...defaultCodePreviewSettings,
        syntaxHighlighting: false,
        toolCallTiming: false,
        toolCallCollapsedStyle: "compact" as const,
        tools: ["bash"],
      };
      const deps: CodePreviewExtensionDependencies = {
        makeRuntime: (api) => makePiManagedRuntime(api, codePreviewApplicationLayer),
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
      yield* step(() => codePreviewsWithDependencies(host.pi, deps));
      const context = extensionContextFixture({
        cwd: "/project",
        isProjectTrusted: () => true,
        ui: { notify() {} },
      });
      const dispatch = (name: string) => host.emit(name, context);
      const row = hostRow(resolvers[0]!("bash", () => downstream));
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
      fresh.setExpanded(true);
      assert.match(fresh.render(80).join("\n"), /COMPLETE RETAINED OUTPUT/);
      yield* step(() => dispatch("session_shutdown"));
    }),
);
