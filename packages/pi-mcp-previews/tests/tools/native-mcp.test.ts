import assert from "node:assert/strict";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { afterEach, test } from "vitest";
import {
  animationSchedulerProbe,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "pi-code-previews/testing";
import { applyPresentationSettings } from "pi-code-previews/testing";
let restoreSettings = () => {};
const setPresentation = (settings: Parameters<typeof applyPresentationSettings>[0]) => {
  restoreSettings();
  restoreSettings = applyPresentationSettings(settings);
};
import { compactStatus, type CompactSummary } from "pi-code-previews";
import { styleNativeMcp } from "../../src/tools/native-mcp-render";
import { nativeMcpSummary } from "../../src/tools/native-mcp-summary";
import { nativeMcpIdentity } from "../../src/tools/native-mcp-subject";
import { stripAnsi } from "pi-cosmic-core";

type NativeDefinition = ToolDefinition<any, any, any>;
type ResourceTool = "list_mcp_resources" | "list_mcp_resource_templates" | "read_mcp_resource";
const resourceTools: readonly ResourceTool[] = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/** Mirrors Pi's fresh `createMcpToolDefinition` output; renderers are Pi's own, never shown. */
function dynamicTool(server = "docs", tool = "lookup", name = `mcp__${server}__${tool}`) {
  const definition: NativeDefinition = {
    name,
    label: `${server}/${tool}`,
    description: `MCP tool ${tool} from server ${server}`,
    parameters: opaqueFixture({ type: "object", properties: { query: { type: "string" } } }),
    outputSchema: opaqueFixture({ type: "object", required: ["content"] }),
    exposure: "direct",
    namespace: { name: `mcp__${server}`, description: `Tools in the mcp__${server} namespace.` },
    annotations: { readOnlyHint: true, openWorldHint: true },
    renderCall: () => new Text("NATIVE_CALL_RENDERER", 0, 0),
    renderResult: () => new Text("NATIVE_RESULT_RENDERER", 0, 0),
    execute: () => Promise.resolve({ content: [], details: { server, tool } }),
  };
  return definition;
}

/** Mirrors Pi's fresh resource tool definitions, which have no renderers or namespace. */
function resourceTool(name: ResourceTool) {
  const definition: NativeDefinition = {
    name,
    label: name,
    description: "MCP resources",
    parameters: opaqueFixture({ type: "object", properties: { server: { type: "string" } } }),
    outputSchema: opaqueFixture({ type: "object" }),
    exposure: "codemode",
    annotations: { readOnlyHint: true },
    execute: () => Promise.resolve({ content: [], details: { server: "", tool: name } }),
  };
  return definition;
}

const result = <Details>(text: string, details: Details): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});
const docs = { server: "docs", tool: "lookup" };

function settings(style: "compact" | "preview", background: "off" | "on" | "border" = "off") {
  setPresentation({
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: style,
    toolCallBackground: background,
  });
}
afterEach(() => restoreSettings());

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
  return nativeMcpSummary(nativeMcpIdentity(definition))({
    phase: "settled",
    args,
    result: value,
    context: renderContextFixture({ isError, isPartial: false, executionStarted: true }),
  });
}

const status = (summary: CompactSummary | undefined) =>
  summary ? compactStatus("settled", summary) : undefined;

/** Control characters other than the style reset that width clipping itself appends. */
const hasControls = (row: string) =>
  [...row.replaceAll("\u001b[0m", "")].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });

for (const style of ["compact", "preview"] as const)
  test(`${style} wrapping replaces only rendering and keeps the registered name`, () => {
    settings(style);
    for (const original of [dynamicTool(), ...resourceTools.map(resourceTool)]) {
      const before = { ...original };
      const styled = styleNativeMcp(original);
      assert.notEqual(styled, original);
      // SAFETY: These keys come directly from this typed native definition fixture.
      const keys = Object.keys(original) as (keyof NativeDefinition)[];
      for (const key of keys) {
        if (key === "renderCall" || key === "renderResult" || key === "renderShell") continue;
        assert.equal(styled[key], original[key], key);
      }
      assert.deepEqual({ ...original }, before, "the fresh definition itself is not mutated");
      const h = createToolPresentationHarness(styled);
      h.call({ query: "effect" });
      h.result(result("done", docs));
      assert.equal(stripAnsi(h.render(100).join("\n")).includes("NATIVE_"), false);
    }
  });

for (const style of ["compact", "preview"] as const)
  test(`${style} headings name the labeled server and tool rather than the model alias`, () => {
    settings(style);
    const alias = "mcp__team_docs__find_page_1a2b3c4d";
    const tool = styleNativeMcp(dynamicTool("team.docs", "find page", alias));
    const h = createToolPresentationHarness(tool);
    h.call({ query: "effect" });
    for (const value of [
      undefined,
      result("Found 3 pages", { server: "team.docs", tool: "find page" }),
    ]) {
      if (value) h.result(value);
      const text = stripAnsi(h.render(100).join("\n"));
      assert.ok(text.includes("team.docs"));
      assert.ok(text.includes("find page"));
      assert.equal(text.includes(alias), false);
    }
    const resource = createToolPresentationHarness(
      styleNativeMcp(resourceTool("read_mcp_resource")),
    );
    resource.call({ server: "docs", uri: "docs://guide/start" });
    assert.ok(stripAnsi(resource.render(100).join("\n")).includes("docs://guide/start"));
  });

test("settled native dispatch is neutral; only native evidence raises warnings", () => {
  const tool = dynamicTool();
  const returned = summarize(tool, result("done", docs), {});
  assert.equal(returned?.outcome, "returned");
  assert.equal(status(returned), "returned");
  for (const name of resourceTools) {
    const payload =
      name === "read_mcp_resource"
        ? "Resource text"
        : JSON.stringify(
            name === "list_mcp_resources"
              ? { server: "docs", resources: [{ server: "docs", uri: "docs://a", name: "a" }] }
              : { server: "docs", resourceTemplates: [] },
          );
    const resource = summarize(
      resourceTool(name),
      result(payload, { server: "docs", tool: name }),
      { server: "docs" },
    );
    assert.equal(status(resource), "returned", name);
  }

  const envelope =
    "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n";
  const saved = summarize(
    tool,
    result(`${envelope}head…tail\n\n[Full output: /tmp/pi-mcp-1.txt (read it with offset/limit)]`, {
      ...docs,
      fullOutputPath: "/tmp/pi-mcp-1.txt",
    }),
    {},
  );
  assert.equal(status(saved), "returned");
  assert.ok(
    saved?.issues?.some(
      (issue) => issue.severity === "info" && issue.detail?.includes("/tmp/pi-mcp-1.txt"),
    ),
  );
  const unsaved = summarize(
    tool,
    result(`${envelope}head…tail\n\n[Could not save the full output: ENOSPC: disk full]`, docs),
    {},
  );
  const warnings = unsaved?.issues?.filter((issue) => issue.severity === "warning") ?? [];
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((issue) => issue.detail?.includes("ENOSPC")));
  for (const issue of [...(saved?.issues ?? []), ...warnings])
    assert.deepEqual(issueMessageStyleProblems(issue.message), []);
});

for (const style of ["compact", "preview"] as const)
  test(`native MCP ${style} keeps saved clipping quiet but preserves loss and error attention`, () => {
    settings(style);
    const definition = dynamicTool();
    const tool = styleNativeMcp(definition);
    for (const path of ["/tmp/RECOVERABLE_OUTPUT", undefined, "", " \n\t "]) {
      const value = result(
        "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n" +
          "TRUNCATED_HEAD\nTRUNCATED_TAIL\n\n" +
          "[Full output: /tmp/RECOVERABLE_OUTPUT (read with offset/limit)]",
        { ...docs, fullOutputPath: path },
      );
      const before = structuredClone(value);
      const saved = path === "/tmp/RECOVERABLE_OUTPUT";
      const summary = summarize(definition, value, {})!;
      const clipping = summary.issues!.find((entry) => entry.code === "mcp-output-truncated")!;
      assert.equal(clipping.severity, saved ? "info" : "warning");
      assert.equal(status(summary), saved ? "returned" : "warning");
      const failed = summarize(definition, value, {}, true)!;
      assert.equal(status(failed), "error");
      assert.ok(failed.issues?.some((entry) => entry.code === "mcp-error"));
      const harness = createToolPresentationHarness(tool);
      for (const frame of harness.cycle({ query: "QUERY_MARKER" }, value)) {
        const text = stripAnsi(frame.text);
        assert.equal(text.includes(clipping.message), frame.expanded || !saved);
        for (const marker of ["Warning: truncated output", "Total output lines:"])
          assert.equal(text.includes(marker), frame.expanded || (style === "preview" && !saved));
        if (saved && !frame.expanded) assert.equal(text.includes("/tmp/RECOVERABLE_OUTPUT"), false);
        if (frame.expanded)
          for (const marker of [
            "QUERY_MARKER",
            "TRUNCATED_HEAD",
            "TRUNCATED_TAIL",
            "/tmp/RECOVERABLE_OUTPUT",
          ])
            assert.ok(text.includes(marker), marker);
      }
      assert.deepEqual(value, before);
    }
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
  // Pi's error flag explains itself even when native details are absent.
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
      assert.equal(tool.execute, original.execute);

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
        assert.ok(rows.length <= 10, `${rows.length} rows at ${width}`);
        for (const row of rows) {
          assert.ok(visibleWidth(row) <= width, row);
          assert.equal(hasControls(row), false, row);
        }
      }
    }
  });

test("theme failures keep collapsed previews bounded while expansion preserves content", () => {
  settings("preview");
  const query = "query-end-".repeat(100);
  const output = Array.from(
    { length: 12 },
    (_, index) => `${index}: ${"long-output-".repeat(100)}`,
  ).join("\n");
  const theme: Theme = opaqueFixture({
    ...plainTheme,
    fg: () => {
      throw new Error("theme unavailable");
    },
    bold: () => {
      throw new Error("theme unavailable");
    },
  });
  const h = createToolPresentationHarness(styleNativeMcp(dynamicTool()), { theme });
  h.call({ query });
  h.result(result(output, docs));
  for (const width of [20, 60, 100]) {
    const rows = h.render(width);
    assert.ok(rows.length <= 8, `${rows.length} rows at ${width}`);
    for (const row of rows) assert.ok(visibleWidth(row) <= width);
  }
  h.call({ query }, { expanded: true });
  h.result(result(output, docs), { expanded: true });
  const expanded = stripAnsi(h.render(4000).join("\n"));
  assert.ok(expanded.includes(query));
  assert.ok(expanded.includes(output.split("\n").at(-1) ?? ""));
});

test("preview issues survive a theme failure in the argument preview", () => {
  settings("preview");
  const value = result("short output", { ...docs, fullOutputPath: "/tmp/full-output.txt" });
  const issues = summarize(dynamicTool(), value, {})?.issues ?? [];
  assert.ok(issues.length > 0);
  const theme: Theme = opaqueFixture({
    ...plainTheme,
    fg: (_token: string, text: string) => {
      if (text.includes("theme-draw-query")) throw new Error("theme unavailable");
      return text;
    },
  });
  const h = createToolPresentationHarness(styleNativeMcp(dynamicTool()), { theme });
  h.call({ query: "theme-draw-query" });
  h.result(value);
  const rendered = stripAnsi(h.render(100).join("\n"));
  for (const issue of issues.filter((entry) => entry.severity !== "info"))
    assert.ok(rendered.includes(issue.message));
});

test("aggregate listings report bounded server failures, pagination, and unreadable coverage", () => {
  const list = resourceTool("list_mcp_resources");
  const aggregate = { server: "", tool: "list_mcp_resources" };
  const failures = Array.from({ length: 5 }, (_, index) => ({
    server: `srv-${index}`,
    error: index === 0 ? "connect ECONNREFUSED 127.0.0.1:9" : `Request timed out after ${index}s`,
  }));
  const failed = summarize(
    list,
    result(
      JSON.stringify({
        resources: [{ server: "docs", uri: "docs://a", name: "a" }],
        errors: failures,
      }),
      aggregate,
    ),
    {},
  );
  assert.equal(failed?.outcome, "returned");
  assert.equal(status(failed), "warning");
  const warnings = failed?.issues?.filter((issue) => issue.severity === "warning") ?? [];
  assert.equal(warnings.length, 4, "three named failures and one bounded remainder");
  for (const index of [0, 1, 2])
    assert.ok(warnings.some((issue) => issue.message.includes(`srv-${index}`)));
  assert.equal(
    warnings.some((issue) => issue.message.includes("srv-3")),
    false,
  );
  for (const issue of warnings) assert.deepEqual(issueMessageStyleProblems(issue.message), []);

  const templates = summarize(
    resourceTool("list_mcp_resource_templates"),
    result(JSON.stringify({ resourceTemplates: [], errors: [failures[1]] }), {
      server: "",
      tool: "list_mcp_resource_templates",
    }),
    {},
  );
  assert.equal(status(templates), "warning");

  const page = summarize(
    list,
    result(JSON.stringify({ server: "docs", resources: [], nextCursor: "opaque" }), {
      server: "docs",
      tool: "list_mcp_resources",
    }),
    { server: "docs" },
  );
  assert.equal(status(page), "returned", "routine pagination is not a warning");
  assert.ok(page?.issues?.some((issue) => issue.severity === "info"));

  const truncated = (server: string) =>
    summarize(
      list,
      result(
        'Warning: truncated output (original token count: 9000)\nTotal output lines: 1\n\n{"resources":[…]}\n\n[Full output: /tmp/list.txt (read it with offset/limit)]',
        { server, tool: "list_mcp_resources", fullOutputPath: "/tmp/list.txt" },
      ),
      server ? { server } : {},
    );
  const unreadable = (server: string) =>
    truncated(server)?.issues?.filter((issue) => issue.severity === "warning").length;
  assert.equal(unreadable(""), 1, "an unreadable aggregate cannot hide failed servers");
  assert.equal(unreadable("docs"), 0, "one server's saved listing remains recoverable");
});

for (const style of ["compact", "preview"] as const)
  test(`${style} running calls show native progress under the injected animation owner`, () => {
    settings(style);
    const probe = animationSchedulerProbe();
    const h = createToolPresentationHarness(styleNativeMcp(dynamicTool(), probe.schedule));
    h.call({ query: "effect" }, { executionStarted: true });
    h.result(result("Indexing 3/10", docs), { isPartial: true });
    assert.ok(stripAnsi(h.render(100).join("\n")).includes("Indexing 3/10"));
    assert.ok(probe.scheduled > 0);
    h.result(result("done", docs));
    h.render(100);
    assert.ok(probe.stops > 0);
  });
