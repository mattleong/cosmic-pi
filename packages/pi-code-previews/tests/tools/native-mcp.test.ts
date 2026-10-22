import assert from "node:assert/strict";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, test } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "pi-code-previews/testing";
import { compactStatus, type CompactSummary } from "pi-code-previews";
import { createNativeMcpRenderers } from "../../src/tools/native-mcp-render";
import { nativeMcpSummary } from "../../src/tools/native-mcp-summary";
import { nativeMcpIdentity } from "../../src/tools/native-mcp-identity";
import { stripAnsi } from "pi-cosmic-core";
import type { HostValue } from "../../src/shared/untrusted-value";

const styleNativeMcp = (
  definition: ToolDefinition,
  schedule = animationSchedulerProbe().schedule,
) =>
  createNativeMcpRenderers(definition.name, definition, undefined, { scheduleAnimation: schedule });

type NativeDefinition = ToolDefinition;
type ResourceTool = "list_mcp_resources" | "list_mcp_resource_templates" | "read_mcp_resource";

function dynamicTool(
  server = "docs",
  tool = "lookup",
  name = `mcp__${server}__${tool}`.replaceAll(/[^A-Za-z0-9_]/g, "_"),
) {
  const definition: NativeDefinition = {
    name,
    label: `${server}/${tool}`,
    description: `MCP tool ${tool} from server ${server}`,
    parameters: { type: "object", properties: { query: { type: "string" } } },
    outputSchema: { type: "object", required: ["content"] },
    exposure: "direct",
    namespace: { name: `mcp__${server.replaceAll("-", "_")}` },
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: () => Promise.resolve({ content: [], details: { server, tool } }),
  };
  return definition;
}

function resourceTool(name: ResourceTool) {
  const definition: NativeDefinition = {
    name,
    label: name,
    description: "MCP resources",
    parameters: { type: "object", properties: { server: { type: "string" } } },
    outputSchema: { type: "object" },
    exposure: "codemode",
    annotations: { readOnlyHint: true },
    execute: () => Promise.resolve({ content: [], details: { server: "", tool: name } }),
  };
  return definition;
}

const result = (text: string, details: HostValue | undefined): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});
const docs = { server: "docs", tool: "lookup" };

const settings = (style: "compact" | "preview", background: "off" | "on" | "border" = "off") =>
  applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: background });
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false, toolCallTiming: false }));

interface NativeArguments {
  readonly query?: string;
  readonly server?: string;
  readonly uri?: string;
}

function summarize(
  definition: NativeDefinition,
  value: AgentToolResult<unknown>,
  args: NativeArguments,
  isError = false,
): CompactSummary | undefined {
  return nativeMcpSummary(nativeMcpIdentity(definition.name, definition))({
    phase: "settled",
    args,
    result: value,
    context: renderContextFixture({ isError, isPartial: false, executionStarted: true }),
  });
}

const status = (summary: CompactSummary | undefined) =>
  summary ? compactStatus("settled", summary) : undefined;

const hasControls = (row: string) =>
  Array.from(row.replaceAll("\u001b[0m", "")).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

test("malformed, foreign, or accessor details decline without invoking getters", () => {
  let touched = false;
  const accessor = Object.defineProperty({ tool: "lookup" }, "server", {
    enumerable: true,
    get() {
      touched = true;
      return "docs";
    },
  });
  for (const details of [
    undefined,
    null,
    [],
    {},
    { server: "docs" },
    { server: "other", tool: "lookup" },
    { server: "docs", tool: "list_mcp_resources" },
    { server: "docs", tool: 7 },
    { ...docs, fullOutputPath: 3 },
    { server: "x".repeat(5000), tool: "lookup" },
    accessor,
  ])
    assert.equal(summarize(dynamicTool(), result("done", details), {}), undefined);
  assert.equal(touched, false);
  assert.equal(
    summarize(resourceTool("list_mcp_resources"), result("[]", docs), {}),
    undefined,
    "evidence from another tool is not this resource tool's",
  );
  const thrown = summarize(
    dynamicTool(),
    result("connect ECONNREFUSED 127.0.0.1:3000", {}),
    {},
    true,
  );
  assert.equal(status(thrown), "error");
});

test("errors are short human issues while expansion keeps full native text and recovery", () => {
  for (const text of [
    "MCP server docs requires sign-in. Run /mcp to sign in.",
    "MCP tool docs/lookup returned an error",
    "Error: HTTP 429 Too Many Requests\n    at fetch (internal)",
    "Run /mcp to reconnect docs before retrying.",
    'Validation failed for tool "mcp__docs__lookup":\n  - query: must be string\n\nReceived arguments:\n{\n  "query": 1\n}',
    "",
  ]) {
    const summary = summarize(dynamicTool(), result(text, docs), {}, true);
    assert.equal(status(summary), "error");
    const error = summary?.issues?.find((issue) => issue.severity === "error");
    assert.ok(error);
    assert.deepEqual(
      issueMessageStyleProblems(error.message, { forbidden: ["mcp__docs__lookup", "Run /mcp"] }),
      [],
    );
  }
  for (const style of ["compact", "preview"] as const) {
    settings(style);
    const h = createToolPresentationHarness(styleNativeMcp(dynamicTool()), { width: 200 });
    const frames = h.cycle(
      { query: "effect" },
      result("MCP server docs requires sign-in. Run /mcp to sign in.", docs),
      { overrides: () => ({ isError: true }) },
    );
    for (const frame of frames.filter((entry) => entry.expanded))
      assert.ok(stripAnsi(frame.text).includes("Run /mcp to sign in."), style);
  }
});

for (const style of ["compact", "preview"] as const)
  for (const background of ["off", "on", "border"] as const)
    test(`${style}/${background} expansion keeps exact arguments, output, saved paths and images`, () => {
      settings(style, background);
      const original = dynamicTool();
      const tool = styleNativeMcp(original);
      const long = `${"L".repeat(600)}END`;
      const args = { query: "effect services", nested: { depth: [1, { flag: true }] }, long };
      const value: AgentToolResult<unknown> = {
        content: [
          {
            type: "text",
            text: `FIRST_OUTPUT\n${"middle\n".repeat(30)}LAST_OUTPUT\n\n[Full output: /tmp/pi-mcp-full.txt (read it with offset/limit)]`,
          },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        details: { ...docs, fullOutputPath: "/tmp/pi-mcp-full.txt" },
      };
      const before = structuredClone(value);
      const h = createToolPresentationHarness(tool, { width: 4000 });
      for (const frame of h.cycle(args, value, {
        invalidate: "after",
        overrides: () => ({ showImages: false }),
      })) {
        if (!frame.expanded) continue;
        const text = stripAnsi(frame.text);
        for (const marker of [
          `"${long}"`,
          '"query": "effect services"',
          '"flag": true',
          "FIRST_OUTPUT",
          "LAST_OUTPUT",
          "/tmp/pi-mcp-full.txt",
          "image/png",
        ])
          assert.ok(text.includes(marker), marker.slice(0, 40));
      }
      assert.deepEqual(value, before);

      const resource = createToolPresentationHarness(
        styleNativeMcp(resourceTool("read_mcp_resource")),
        { width: 4000 },
      );
      const uri = `docs://guide/${"chapter/".repeat(40)}end`;
      resource.call({ server: "docs", uri }, { expanded: true });
      resource.result(result("Resource body", { server: "docs", tool: "read_mcp_resource" }), {
        expanded: true,
      });
      const text = stripAnsi(resource.render().join("\n"));
      assert.ok(text.includes(`"uri": "${uri}"`));
      assert.ok(text.includes("Resource body"));
    });

for (const style of ["compact", "preview"] as const)
  test(`${style} collapsed previews stay bounded and terminal-control safe`, () => {
    settings(style);
    const hostile = "\u001b[31mRED\u001b[0m\u001b]0;title\u0007\r\u009b2J";
    const output = Array.from(
      { length: 40 },
      (_, index) => `line ${index} ${hostile} ${"x".repeat(300)}`,
    ).join("\n");
    const tool = styleNativeMcp(dynamicTool(`docs${hostile}`, `look${hostile}up`));
    for (const partial of [true, false]) {
      const h = createToolPresentationHarness(tool);
      h.call({ query: hostile }, { executionStarted: true });
      h.result(
        result(partial ? `Indexing ${hostile}` : output, {
          server: `docs${hostile}`,
          tool: `look${hostile}up`,
        }),
        { isPartial: partial },
      );
      for (const width of [20, 60, 100]) {
        const rows = h.render(width);
        assert.ok(rows.length <= 12, `${rows.length} rows at ${width}`);
        for (const row of rows) {
          assert.ok(visibleWidth(row) <= width, row);
          assert.equal(hasControls(row), false, row);
        }
      }
    }
  });

for (const style of ["compact", "preview"] as const)
  test(`${style} running calls show native progress under the injected animation owner`, () => {
    settings(style);
    const probe = animationSchedulerProbe();
    const h = createToolPresentationHarness(styleNativeMcp(dynamicTool(), probe.schedule));
    h.call({ query: "effect" }, { executionStarted: true });
    h.result(result("\u001b[2K\nIndexing 3/10", docs), { isPartial: true });
    assert.ok(stripAnsi(h.render(100).join("\n")).includes("Indexing 3/10"));
    assert.ok(probe.scheduled > 0);
    h.result(result("done", docs));
    h.render(100);
    assert.ok(probe.stops > 0);
  });
