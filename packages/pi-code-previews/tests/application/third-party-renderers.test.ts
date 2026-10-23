import assert from "node:assert/strict";
import { initTheme, type ToolInfo, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, it } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { createToolPresentationHarness, drawToolRow, hostToolRow } from "../../testing";
import { inertScheduler as scheduler, presentationResolver } from "../support/renderer-host";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

beforeAll(() => initTheme("dark", false));
afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));
const info = (name = "web_search"): ToolInfo => ({
  name,
  description: name,
  parameters: {},
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
const setup = (tools: () => ToolInfo[], ready = true) =>
  presentationResolver(
    {
      getAllTools: tools,
      registerTool: () => {
        throw new Error("execution registration");
      },
      getActiveTools: () => {
        throw new Error("activation access");
      },
      setActiveTools: () => {
        throw new Error("activation mutation");
      },
    },
    ready ? [] : undefined,
  );

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
      const resolved = resolver(name, () => {
        return poisoned;
      });
      assert.notEqual(resolved?.renderCall, downstream.renderCall);
      owner.retire();
    }
  }
});

it("foreign, missing, duplicate, lookalike, renamed, and unsupported sources fall through", () => {
  const base = info();
  const baseDir = base.sourceInfo.baseDir;
  assert.ok(baseDir);
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
    { ...base.sourceInfo, path: `${baseDir}/dist/other.js` },
    { ...base.sourceInfo, path: `${baseDir}/dist/../dist/index.js` },
  ];
  for (const ready of [true, false]) {
    for (const tools of [
      [],
      [base, base],
      ...Arr.map(sources, (sourceInfo) => [{ ...base, sourceInfo }]),
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

for (const style of ["compact"] as const)
  for (const mode of ["off"] as const)
    it(`verified cold replay adopts ${style}/${mode} while retaining exact input, output, and downstream extras`, () => {
      const { owner, resolver } = setup(() => [info()], false);
      const args = { queries: ["first query", "QUERY_TAIL"], domainFilter: ["example.test"] };
      const row = hostToolRow(
        "web_search",
        args,
        resolver("web_search", () => downstream),
        {
          result: {
            content: [{ type: "text", text: "COMPLETE OUTPUT RECOVERY_TAIL" }],
            details: { queryCount: 2, successfulQueries: 2, totalResults: 4 },
            isError: false,
          },
        },
      );
      assert.match(Arr.join(row.render(100), "\n"), /ORIGINAL OUTPUT/);
      setCodePreviewSettings({
        ...defaultCodePreviewSettings,
        toolCallCollapsedStyle: style,
        toolCallBackground: mode,
        toolCallTiming: false,
      });
      owner.publish("/project", new Set(), scheduler);
      const expanded = drawToolRow(row, true, 100);
      for (const marker of [
        "QUERY_TAIL",
        "example.test",
        "RECOVERY_TAIL",
        "ORIGINAL CALL",
        "ORIGINAL OUTPUT",
      ])
        assert.ok(Fn.pipe(expanded, Str.includes(marker)), marker);
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
  assert.match(Arr.join(harness.render(), "\n"), /ORIGINAL OUTPUT/);
  assert.doesNotMatch(Arr.join(harness.render(), "\n"), /RAW OUTPUT/);
  owner.retire();
});
