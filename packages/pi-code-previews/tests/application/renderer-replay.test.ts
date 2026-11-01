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
import type { CodePreviewRenderers } from "../../src/tools/renderers/shared/types";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

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

for (const admission of ["native", "foreign", "missing", "error"] as const) {
  it(`cold codemode replay survives error metadata then ${admission} readiness`, () => {
    let metadata: ToolInfo[] = [];
    let broken = true;
    const { owner, resolver } = presentationResolver({
      getAllTools: () => {
        if (broken) throw new Error("public metadata not bound");
        return metadata;
      },
    });
    const renderers = resolver("codemode", () => downstream);
    assert.equal(renderers?.renderShell, "self");
    const row = hostToolRow("codemode", { code: "text('EXACT_SOURCE');" }, renderers, {
      result: output,
    });
    assert.match(Arr.join(row.render(100), "\n"), /NATIVE RESULT CONTENT/);
    broken = admission === "error";
    if (admission === "native") metadata = [info("codemode")];
    if (admission === "foreign")
      metadata = [
        { ...info("codemode"), sourceInfo: { ...info("codemode").sourceInfo, source: "foreign" } },
      ];
    setPlainPreviewSettings({
      toolCallCollapsedStyle: "compact",
      toolCallBackground: "border",
      tools: ["codemode"],
    });
    owner.publish("/project", new Set(["codemode"]), scheduler);
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

it("a real retained host row adopts first-ready preview/border with complete call and result", () => {
  const { owner, resolver } = presentationResolver({ getAllTools: () => [info("bash")] });
  const renderers = resolver("bash", () => downstream);
  assert.equal(renderers?.renderShell, "self");
  const row = hostRow(renderers);
  assert.match(Arr.join(row.render(80), "\n"), /NATIVE CALL CONTENT/);
  assert.match(Arr.join(row.render(80), "\n"), /NATIVE RESULT CONTENT/);
  setPlainPreviewSettings({
    toolCallCollapsedStyle: "preview",
    toolCallBackground: "border",
    tools: ["bash"],
  });
  owner.publish("/project", new Set(["bash"]), scheduler);
  for (const expanded of [true, false, true]) {
    const rendered = drawToolRow(row, expanded, 80);
    assert.match(rendered, /EXACT_SOURCE/);
    assert.match(rendered, /COMPLETE RETAINED OUTPUT/);
    assert.doesNotMatch(rendered, /NATIVE RESULT CONTENT/);
  }
  row.setExpanded(false);
  row.render(80);
  const mouse = row.handleMouse({
    type: "click",
    button: "left",
    x: 2,
    y: 1,
    screenX: 2,
    screenY: 1,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(mouse?.handled, true);
  assert.match(Arr.join(row.render(80), "\n"), /COMPLETE RETAINED OUTPUT/);
  owner.retire();
});

it("retained tool search adopts preview/on without borrowing replacement ownership", () => {
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
  assert.match(Arr.join(row.render(80), "\n"), /NATIVE RESULT CONTENT/);
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallTiming: false,
    toolCallCollapsedStyle: "preview",
    toolCallBackground: "on",
  });
  owner.publish("/first", new Set(["tool_search"]), scheduler);
  for (const expanded of [false, true, false, true]) {
    const rendered = drawToolRow(row, expanded, 80);
    assert.match(rendered, /EXACT_QUERY/);
    assert.doesNotMatch(rendered, /NATIVE RESULT CONTENT/);
    assert.equal(Fn.pipe(rendered, Str.includes("COMPLETE RETAINED OUTPUT")), expanded);
    if (expanded) assert.match(rendered, /"limit": 7/);
  }
  owner.retire();
  owner = new CodePreviewPresentationOwner();
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [],
    toolCallCollapsedStyle: "compact",
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
  assert.match(Arr.join(row.render(80), "\n"), /COMPLETE RETAINED OUTPUT/);
  assert.equal(first.session?.collapsedStyle, "preview");
  assert.equal(first.session?.mode, "on");
  assert.equal(replacementSchedules, 0);
  assert.equal(resolver("tool_search", () => downstream)?.renderCall, downstream.renderCall);
  owner.retire();
});

it("lazy bash draw adoption refeeds stored result without host refresh or execution events", () => {
  const context = renderContextFixture({
    args: { command: "echo EXACT_SOURCE" },
    expanded: true,
    isPartial: false,
    invalidate() {},
  });
  const { owner, resolver } = presentationResolver({ getAllTools: () => [info("bash")] });
  const renderers = resolver("bash", () => downstream)!;
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
    tools: ["bash"],
  });
  owner.publish("/project", new Set(["bash"]), scheduler);
  const rendered = Arr.join([...call.render(80), ...result.render(80)], "\n");
  assert.match(rendered, /EXACT_SOURCE/);
  assert.match(rendered, /COMPLETE RETAINED OUTPUT/);
  owner.retire();
});

interface PanelState {
  resultWasSeen?: boolean;
}

it("cold and declined rows preserve independent downstream caches and live panel state", () => {
  const { owner, resolver } = presentationResolver({ getAllTools: () => [info("bash")] });
  const panels: CodePreviewRenderers<unknown, unknown, PanelState> = {
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
  assert.match(Arr.join(row.render(80), "\n"), /CALL SAW OUTPUT/);
  owner.publish("/project", new Set(), scheduler);
  row.setExpanded(true);
  assert.match(Arr.join(row.render(80), "\n"), /CALL SAW OUTPUT/);
  assert.match(Arr.join(row.render(80), "\n"), /RESULT PANEL/);
  owner.retire();
});

it("retired replay rows never adopt the replacement owner's settings", () => {
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
  assert.match(Arr.join(old.render(80), "\n"), /NATIVE RESULT CONTENT/);
  const fresh = hostRow(resolver("bash", () => downstream));
  fresh.setExpanded(true);
  assert.match(Arr.join(fresh.render(80), "\n"), /COMPLETE RETAINED OUTPUT/);
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
      const dispatch = (name: "session_start" | "session_shutdown") => host.emit(name, context);
      const row = hostRow(resolvers[0]!("bash", () => downstream));
      const starting = dispatch("session_start");
      yield* Deferred.await(entered);
      assert.match(Arr.join(row.render(80), "\n"), /NATIVE RESULT CONTENT/);
      yield* Deferred.succeed(release, undefined);
      yield* step(() => starting);
      yield* step(() => dispatch("session_start"));
      assert.equal(resolvers.length, 1);
      row.invalidate();
      assert.match(Arr.join(row.render(80), "\n"), /NATIVE RESULT CONTENT/);
      const fresh = hostRow(resolvers[0]!("bash", () => downstream));
      fresh.setExpanded(true);
      assert.match(Arr.join(fresh.render(80), "\n"), /COMPLETE RETAINED OUTPUT/);
      yield* step(() => dispatch("session_shutdown"));
    }),
);
