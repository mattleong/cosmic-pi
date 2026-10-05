import assert from "node:assert/strict";
import {
  initTheme,
  ToolExecutionComponent,
  type ToolInfo,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, it } from "vitest";
import { extensionApiFixture, opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../../src/application/tool-renderers";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { createToolPresentationHarness, renderContextFixture } from "../../testing";

beforeAll(() => initTheme("dark", false));
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));
const scheduler = { defer: () => () => undefined, schedule: () => () => undefined };
const info = (name = "web_search"): ToolInfo => ({
  name,
  description: name,
  parameters: opaqueFixture({}),
  exposure: "codemode",
  sourceInfo: {
    source: "npm:pi-web-access@0.36.0",
    origin: "package",
    scope: "user",
    baseDir: "/agent/npm/node_modules/pi-web-access",
    path: "/agent/npm/node_modules/pi-web-access/dist/index.js",
  },
});
const downstream: ToolRenderers = {
  renderCall: () => new Text("ORIGINAL CALL", 0, 0),
  renderResult: () => new Text("ORIGINAL OUTPUT", 0, 0),
};
function setup(tools: () => ToolInfo[], ready = true) {
  const pi = extensionApiFixture({
    getAllTools: tools,
    getCommands: () => [],
    registerTool: () => {
      throw new Error("execution registration");
    },
    getActiveTools: () => {
      throw new Error("activation access");
    },
    setActiveTools: () => {
      throw new Error("activation mutation");
    },
  });
  const owner = new CodePreviewPresentationOwner();
  if (ready) owner.publish("/project", new Set(), scheduler);
  return { owner, resolver: createCodePreviewRendererResolver(pi, () => owner, new Set()) };
}

it("admits supported npm identities without executing, enabling, or reading private definition fields", () => {
  for (const source of [
    "npm:pi-web-access",
    "npm:pi-web-access@0.36.0",
    "npm:pi-web-access@latest",
  ]) {
    for (const name of [
      "web_enable",
      "web_search",
      "source_check",
      "fetch_content",
      "get_search_content",
    ]) {
      const tool = info(name);
      tool.sourceInfo.source = source;
      const { owner, resolver } = setup(() => [tool]);
      const poisoned = Object.defineProperties(
        { ...downstream },
        {
          execute: {
            get() {
              throw new Error("private execution");
            },
          },
          parameters: {
            get() {
              throw new Error("private schema");
            },
          },
        },
      );
      let next = 0;
      const resolved = resolver(name, () => {
        next++;
        return poisoned;
      });
      assert.equal(next, 1);
      assert.notEqual(resolved?.renderCall, downstream.renderCall);
      owner.retire();
    }
  }
});

it("foreign, missing, duplicate, lookalike, renamed, and unsupported sources fall through", () => {
  const base = info();
  const sources = [
    { ...base.sourceInfo, source: "npm:pi-web-access-extra" },
    { ...base.sourceInfo, source: "npm:pi-web-access@npm:another-package" },
    { ...base.sourceInfo, source: "npm:pi-web-access@file:/foreign/package" },
    { ...base.sourceInfo, source: "npm:pi-web-access@https://example.test/package.tgz" },
    { ...base.sourceInfo, source: "npm:other@npm:pi-web-access" },
    { ...base.sourceInfo, source: "local" },
    { ...base.sourceInfo, source: "builtin" },
    { ...base.sourceInfo, origin: "top-level" as const },
    {
      source: base.sourceInfo.source,
      origin: base.sourceInfo.origin,
      scope: base.sourceInfo.scope,
      path: base.sourceInfo.path,
    },
    { ...base.sourceInfo, path: "/agent/npm/node_modules/pi-web-access-extra/dist/index.js" },
    { ...base.sourceInfo, path: `${base.sourceInfo.baseDir}/dist/other.js` },
    { ...base.sourceInfo, path: `${base.sourceInfo.baseDir}/dist/../dist/index.js` },
  ];
  for (const ready of [true, false]) {
    for (const tools of [
      [],
      [base, base],
      ...sources.map((sourceInfo) => [{ ...base, sourceInfo }]),
    ]) {
      const { owner, resolver } = setup(() => tools, ready);
      assert.equal(resolver("web_search", () => downstream)?.renderCall, downstream.renderCall);
      owner.retire();
    }
    const { owner, resolver } = setup(() => [info("renamed_search")], ready);
    assert.equal(
      resolver("renamed_search", () => downstream)?.renderResult,
      downstream.renderResult,
    );
    owner.retire();
  }
});

it("supports the declared source entry and Windows package paths through public metadata only", () => {
  for (const [baseDir, path] of [
    ["/agent/npm/node_modules/pi-web-access", "/agent/npm/node_modules/pi-web-access/index.ts"],
    [
      "C:\\agent\\node_modules\\pi-web-access",
      "C:\\agent\\node_modules\\pi-web-access\\dist\\index.js",
    ],
  ] as const) {
    const tool = info();
    tool.sourceInfo = { ...tool.sourceInfo, baseDir, path };
    const { owner, resolver } = setup(() => [tool]);
    assert.notEqual(resolver("web_search", () => downstream)?.renderCall, downstream.renderCall);
    owner.retire();
  }
});

it("later registration is picked up without changing activation or borrowing a retired owner", () => {
  let tools: ToolInfo[] = [];
  const { owner, resolver } = setup(() => tools);
  assert.equal(resolver("web_search", () => downstream)?.renderCall, downstream.renderCall);
  tools = [info()];
  assert.notEqual(resolver("web_search", () => downstream)?.renderCall, downstream.renderCall);
  owner.retire();
  assert.equal(resolver("web_search", () => downstream)?.renderCall, downstream.renderCall);
});

for (const style of ["preview", "compact"] as const)
  for (const mode of ["on", "off", "border"] as const)
    it(`verified cold replay adopts ${style}/${mode} while retaining exact input, output, and downstream extras`, () => {
      const { owner, resolver } = setup(() => [info()], false);
      const args = { queries: ["first query", "QUERY_TAIL"], domainFilter: ["example.test"] };
      const row = new ToolExecutionComponent(
        "web_search",
        "replay",
        args,
        { showImages: false },
        resolver("web_search", () => downstream),
        opaqueFixture({ requestRender() {} }),
        "/project",
      );
      row.updateResult({
        content: [{ type: "text", text: "COMPLETE OUTPUT RECOVERY_TAIL" }],
        details: { queryCount: 2, successfulQueries: 2, totalResults: 4 },
        isError: false,
      });
      assert.match(row.render(100).join("\n"), /ORIGINAL OUTPUT/);
      setCodePreviewSettings({
        ...defaultCodePreviewSettings,
        toolCallCollapsedStyle: style,
        toolCallBackground: mode,
        toolCallTiming: false,
      });
      owner.publish("/project", new Set(), scheduler);
      row.setExpanded(true);
      row.invalidate();
      const expanded = row.render(100).join("\n");
      for (const marker of [
        "QUERY_TAIL",
        "example.test",
        "RECOVERY_TAIL",
        "ORIGINAL CALL",
        "ORIGINAL OUTPUT",
      ])
        assert.ok(expanded.includes(marker), marker);
      owner.retire();
    });

it("changed ownership before readiness leaves a retained external row downstream", () => {
  let tools = [info()];
  const { owner, resolver } = setup(() => tools, false);
  const harness = createToolPresentationHarness(resolver("web_search", () => downstream)!);
  harness.call({ query: "query" });
  harness.result({ content: [{ type: "text", text: "RAW OUTPUT" }], details: {} });
  tools = [{ ...info(), sourceInfo: { ...info().sourceInfo, source: "npm:other" } }];
  owner.publish("/project", new Set(), scheduler);
  harness.call({ query: "query" }, { expanded: true });
  assert.match(harness.render().join("\n"), /ORIGINAL OUTPUT/);
  assert.doesNotMatch(harness.render().join("\n"), /RAW OUTPUT/);
  owner.retire();
});

it("separately resolved call/result slots preserve the original result and images", () => {
  const { owner, resolver } = setup(() => [info("fetch_content")]);
  const args = { url: "https://example.test" };
  const state = {};
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const result = {
    content: [{ type: "text" as const, text: "RECOVERY_TAIL" }, image],
    details: { urlCount: 1, successful: 1 },
  };
  Object.freeze(result.content);
  Object.freeze(result.details);
  resolver("fetch_content", () => downstream)!.renderCall!(
    args,
    plainTheme,
    renderContextFixture({ state, args, expanded: true }),
  );
  const component = resolver("fetch_content", () => downstream)!.renderResult!(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    renderContextFixture({ state, args, expanded: true, isPartial: false, executionStarted: true }),
  );
  assert.match(component.render(100).join("\n"), /RECOVERY_TAIL/);
  assert.equal(result.content[1], image);
  owner.retire();
});
