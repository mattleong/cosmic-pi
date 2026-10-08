import assert from "node:assert/strict";
import type { AgentToolResult, ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, it } from "vitest";
import { extensionApiFixture, plainTheme } from "pi-cosmic-core/testing";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
  publishPreviewToolStatuses,
} from "../../src/application/tool-renderers";
import { capturePreviewHostTools } from "../../src/boundary/host-tool-renderers";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { getCodePreviewToolStatuses } from "../../src/tools/status";
import { createToolPresentationHarness, renderContextFixture } from "../../testing";
import {
  builtinToolInfo as info,
  inertScheduler as scheduler,
  presentationResolver,
  setPlainPreviewSettings,
} from "../support/renderer-host";

const downstream: ToolRenderers = {
  renderCall: () => new Text("DOWNSTREAM CALL", 0, 0),
  renderResult: () => new Text("DOWNSTREAM RESULT", 0, 0),
};
const manager = {
  name: "mcp",
  sourceInfo: { source: "builtin", path: "builtin:mcp", scope: "temporary", origin: "top-level" },
};

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

it("keeps foreign and unrelated renderers, calls next once, and never inspects execution fields", () => {
  const { resolver } = presentationResolver(
    {
      getAllTools: () => [
        { ...info("read"), sourceInfo: { ...info("read").sourceInfo, source: "foreign" } },
      ],
    },
    ["read"],
  );
  const foreign = Object.defineProperty({ ...downstream }, "execute", {
    get: () => {
      throw new Error("private definition access");
    },
  });
  for (const name of ["read", "unrelated", "toString", "codemode", "mcp__docs__lookup"]) {
    let calls = 0;
    const resolved = resolver(name, () => {
      calls++;
      return foreign;
    });
    assert.equal(calls, 1);
    assert.equal(resolved?.renderCall, downstream.renderCall);
    assert.equal(resolved?.renderResult, downstream.renderResult);
  }
});

it("native tool search rejects foreign, misspelled, inline, duplicate, and missing ownership", () => {
  const native = info("tool_search");
  let tools: ToolInfo[] = [];
  const { pi, owner, resolver } = presentationResolver(
    {
      getAllTools: () => tools,
      getActiveTools() {
        throw new Error("selection access");
      },
      setActiveTools() {
        throw new Error("selection mutation");
      },
      registerTool() {
        throw new Error("execution registration");
      },
    },
    ["tool_search"],
  );
  for (const rejected of [
    [],
    [info("tool_search", "builtin:tool_search")],
    [info("tool_search", "builtin:tool-search/extra")],
    [{ ...native, sourceInfo: { ...native.sourceInfo, source: "foreign" } }],
    [
      {
        ...native,
        sourceInfo: { ...native.sourceInfo, source: "inline", path: "<inline:tool-search>" },
      },
    ],
    [native, native],
  ]) {
    tools = rejected;
    assert.equal(resolver("tool_search", () => downstream)?.renderCall, downstream.renderCall);
    publishPreviewToolStatuses(capturePreviewHostTools(pi), new Set(["tool_search"]), new Set());
    assert.notEqual(getCodePreviewToolStatuses().get("tool_search")?.state, "installed");
  }
  tools = [native];
  const renderers = resolver("tool_search", () => downstream)!;
  const h = createToolPresentationHarness(renderers);
  h.call({ query: "EXACT_QUERY" });
  h.result({ content: [{ type: "text", text: "EXACT_OUTPUT" }], details: { loaded: [] } });
  assert.match(h.render(80).join("\n"), /EXACT_QUERY/);
  publishPreviewToolStatuses(capturePreviewHostTools(pi), new Set(["tool_search"]), new Set());
  assert.equal(getCodePreviewToolStatuses().get("tool_search")?.state, "installed");
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: [] });
  assert.notEqual(
    resolver("tool_search", () => downstream)?.renderCall,
    downstream.renderCall,
    "selection remains captured until replacement",
  );
  owner.retire();
  const excluded = new CodePreviewPresentationOwner();
  excluded.publish("/next", new Set(), scheduler);
  assert.equal(
    createCodePreviewRendererResolver(
      pi,
      () => excluded,
      new Set(),
    )("tool_search", () => downstream)?.renderCall,
    downstream.renderCall,
  );
  excluded.retire();
});

it("requires exact native sources and a unique builtin MCP manager for missing history", () => {
  let tools = [info("codemode", "builtin:other"), info("mcp__docs__lookup", "builtin:other")];
  let commands = [manager];
  const { resolver } = presentationResolver({
    getAllTools: () => tools,
    getCommands: () => commands,
  });
  assert.equal(resolver("codemode", () => downstream)?.renderCall, downstream.renderCall);
  assert.equal(resolver("mcp__docs__lookup", () => downstream)?.renderCall, downstream.renderCall);
  assert.equal(resolver("mcp__missing__history", () => downstream)?.renderShell, "self");
  commands = [manager, manager];
  assert.equal(
    resolver("mcp__missing__history", () => downstream)?.renderCall,
    downstream.renderCall,
  );
  tools = [info("codemode")];
  assert.equal(resolver("codemode", () => downstream)?.renderShell, "self");
});

it("claims registered MCP definitions only from the exact builtin MCP source", () => {
  const name = "mcp__team_docs__find_page";
  let tools: ToolInfo[] = [];
  let commands = [manager];
  for (const ready of [false, true]) {
    const { owner, resolver } = presentationResolver(
      { getAllTools: () => tools, getCommands: () => commands },
      ready ? [] : undefined,
    );
    const claims = (toolName: string) =>
      resolver(toolName, () => downstream)?.renderCall !== downstream.renderCall;
    for (const [source, path] of [
      ["foreign", "builtin:mcp"],
      ["foreign", "<inline:foreign>"],
      ["builtin", "builtin:mcp-lookalike"],
      ["builtin", "some/builtin:mcp"],
      ["builtin", "builtin:mcp/extra"],
    ] as const) {
      tools = [{ ...info(name), sourceInfo: { ...info(name).sourceInfo, source, path } }];
      assert.equal(claims(name), false, `${source} ${path}`);
    }
    tools = [info("mcp", "builtin:mcp")];
    assert.equal(claims("mcp"), false, "the retired gateway name is never claimed");
    tools = [];
    commands = [];
    assert.equal(claims(name), false, "missing history needs a proven manager");
    commands = [manager];
    assert.equal(claims(name), true);
    tools = [info(name)];
    assert.equal(claims(name), true);
    owner.retire();
  }
});

it("only exact native MCP aliases leave Pi's own presentation", () => {
  const { resolver } = presentationResolver({
    getAllTools: () => [],
    getCommands: () => [manager],
  });
  assert.equal(
    resolver("mcp__docs-site__lookup", () => downstream)?.renderCall,
    downstream.renderCall,
  );
  assert.notEqual(
    resolver("mcp__docs_site__lookup", () => downstream)?.renderCall,
    downstream.renderCall,
  );
});

for (const style of ["preview", "compact"] as const)
  for (const background of ["on", "off", "border"] as const)
    it(`${style}/${background} ready rows keep output when each slot is resolved separately`, () => {
      setPlainPreviewSettings({
        toolCallCollapsedStyle: style,
        toolCallBackground: background,
        tools: ["bash"],
      });
      const { owner, resolver } = presentationResolver({ getAllTools: () => [info("bash")] }, [
        "bash",
      ]);
      // HTML export resolves renderers for each slot and shares only the row's state.
      const args = { command: "echo exact" };
      const state = {};
      const call = resolver("bash", () => downstream)!.renderCall!(
        args,
        plainTheme,
        renderContextFixture({ args, state, executionStarted: true }),
      );
      call.render(100);
      const result = resolver("bash", () => downstream)!.renderResult!(
        { content: [{ type: "text", text: "COMPLETE OUTPUT" }], details: {} },
        { expanded: true, isPartial: false },
        plainTheme,
        renderContextFixture({
          args,
          state,
          executionStarted: true,
          expanded: true,
          isPartial: false,
        }),
      );
      assert.match(result.render(100).join("\n"), /COMPLETE OUTPUT/);
      owner.retire();
    });

it("renders inactive builtin tools without touching active selection or execution registration", () => {
  setPlainPreviewSettings({ tools: ["read"], toolCallCollapsedStyle: "compact" });
  const { pi, resolver } = presentationResolver(
    {
      getAllTools: () => [info("read")],
      getActiveTools: () => {
        throw new Error("selection access");
      },
      setActiveTools: () => {
        throw new Error("selection mutation");
      },
      registerTool: () => {
        throw new Error("execution mutation");
      },
    },
    ["read"],
  );
  const renderers = resolver("read", () => downstream)!;
  const harness = createToolPresentationHarness(renderers);
  harness.call({ path: "/project/file.ts" });
  harness.result({ content: [{ type: "text", text: "COMPLETE OUTPUT" }], details: {} });
  assert.match(harness.render(80).join("\n"), /file\.ts/);
  harness.call({ path: "/project/file.ts" }, { expanded: true });
  assert.match(harness.render(80).join("\n"), /COMPLETE OUTPUT/);
  publishPreviewToolStatuses(capturePreviewHostTools(pi), new Set(["read"]), new Set());
  assert.equal(getCodePreviewToolStatuses().get("read")?.state, "installed");
});

it("new rows keep origin-owner appearance and tool selection until the next session", () => {
  setPlainPreviewSettings({
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "off",
    tools: ["bash", "codemode"],
  });
  const pi = extensionApiFixture({
    getAllTools: () => [
      info("bash"),
      info("codemode"),
      { ...info("mcp__docs__lookup"), namespace: { name: "mcp__docs" } },
    ],
    getCommands: () => [],
  });
  let owner = new CodePreviewPresentationOwner();
  owner.publish("/project", new Set(["bash", "codemode"]), scheduler);
  const resolver = createCodePreviewRendererResolver(pi, () => owner, new Set());
  const fixtures: Array<{
    name: string;
    args: object;
    result: AgentToolResult<unknown>;
    marker: string;
  }> = [
    {
      name: "bash",
      args: { command: "echo exact" },
      result: { content: [{ type: "text", text: "COMPLETE OUTPUT" }], details: {} },
      marker: "COMPLETE OUTPUT",
    },
    {
      name: "codemode",
      args: { code: "text('EXACT_SOURCE');" },
      result: {
        content: [
          { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          { type: "text", text: "native output" },
        ],
        details: { calls: [] },
      },
      marker: "EXACT_SOURCE",
    },
    {
      name: "mcp__docs__lookup",
      args: { query: "guide" },
      result: {
        content: [{ type: "text", text: "COMPLETE MCP OUTPUT" }],
        details: { server: "docs", tool: "lookup" },
      },
      marker: "COMPLETE MCP OUTPUT",
    },
  ];
  const old = fixtures.map((fixture) => {
    const harness = createToolPresentationHarness(resolver(fixture.name, () => downstream)!);
    harness.call(fixture.args);
    harness.result(fixture.result);
    return harness;
  });
  setPlainPreviewSettings({
    toolCallCollapsedStyle: "preview",
    toolCallBackground: "border",
    tools: ["codemode"],
  });
  for (const [index, fixture] of fixtures.entries()) {
    old[index]!.invalidate();
    assert.equal(old[index]!.render(120).join("\n").includes(fixture.marker), false);
    const fresh = createToolPresentationHarness(resolver(fixture.name, () => downstream)!);
    fresh.call(fixture.args);
    fresh.result(fixture.result);
    assert.equal(fresh.render(120).join("\n").includes(fixture.marker), false);
  }
  assert.equal(owner.session?.mode, "off");
  owner.retire();
  owner = new CodePreviewPresentationOwner();
  owner.publish("/replacement", new Set(["codemode"]), scheduler);
  assert.equal(resolver("bash", () => downstream)?.renderCall, downstream.renderCall);
  for (const fixture of fixtures.slice(1)) {
    const fresh = createToolPresentationHarness(resolver(fixture.name, () => undefined)!);
    fresh.call(fixture.args);
    fresh.result(fixture.result);
    assert.equal(fresh.render(120).join("\n").includes(fixture.marker), true);
  }
  assert.equal(owner.session?.mode, "border");
  owner.retire();
});

it("retired or declined animation admission never borrows a replacement scheduler", () => {
  const first = new CodePreviewPresentationOwner();
  let ticks = 0;
  let cancels = 0;
  let callback: (() => void) | undefined;
  assert.equal(
    first.scheduleAnimation(20, () => ticks++),
    undefined,
  );
  first.publish("/first", new Set(), {
    ...scheduler,
    schedule: (_interval, tick) => {
      callback = tick;
      return () => cancels++;
    },
  });
  const stop = first.scheduleAnimation(20, () => ticks++);
  callback?.();
  assert.equal(ticks, 1);
  first.retire();
  const second = new CodePreviewPresentationOwner();
  let replacementAdmissions = 0;
  second.publish("/second", new Set(), {
    ...scheduler,
    schedule: () => {
      replacementAdmissions++;
      return () => undefined;
    },
  });
  callback?.();
  assert.equal(
    first.scheduleAnimation(20, () => ticks++),
    undefined,
  );
  assert.equal(ticks, 1);
  assert.equal(cancels, 1);
  assert.equal(replacementAdmissions, 0);
  // Cancellation remains harmless if the content clears its stored subscription later.
  stop?.();
  assert.equal(cancels, 1);
  second.retire();
});
