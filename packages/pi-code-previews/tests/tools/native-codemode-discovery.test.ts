import assert from "node:assert/strict";
import { test } from "vitest";
import { createNativeDiscoveryProjector } from "../../src/tools/native-codemode-discovery";

const project = (code: string) => createNativeDiscoveryProjector()({ code });

test("recognizes direct MCP-targeted discovery without counting helper executions", () => {
  for (const code of [
    'text(await describeTool("mcp__docs__lookup"));',
    'return await describeNamespace("mcp__chrome_devtools");',
    'text(await searchTools("navigation", { limit: 1, namespace: "mcp__chrome_devtools" }));',
    'text(await describeTool("read_mcp_resource"));',
    'text(await describeTool("\\u006dcp__docs__lookup"));',
    'text(`Schema: ${await describeNamespace("mcp__docs")}`);',
    '// @options: {"timeout_ms": 60000}\nconsole.log(await describeNamespace("mcp__docs"));',
    'return Promise.all([describeNamespace("mcp__docs"), describeTool("read")]);',
  ])
    assert.deepEqual(project(code), { kind: "mcp", discoveryOnly: true });
});

test("shadowed, mutated, or dynamically replaced helpers conservatively fall through", () => {
  for (const code of [
    'const describeTool = custom; await describeTool("mcp__docs__lookup");',
    'function describeNamespace() {} await describeNamespace("mcp__docs");',
    'let { searchTools } = custom; await searchTools("query", { namespace: "mcp__docs" });',
    'describeTool = custom; await describeTool("mcp__docs__lookup");',
    'globalThis.describeTool = custom; await describeTool("mcp__docs__lookup");',
    'globalThis[key] = custom; await describeNamespace("mcp__docs");',
    'eval(source); await describeNamespace("mcp__docs");',
    'new Function(source)(); await describeNamespace("mcp__docs");',
    'for (describeNamespace of [custom]) await describeNamespace("mcp__docs");',
    'for ({ lookup: describeNamespace } of values) await describeNamespace("mcp__docs");',
    'for (describeNamespace in values) await describeNamespace("mcp__docs");',
    'delete globalThis.describeNamespace; await describeNamespace("mcp__docs");',
  ])
    assert.equal(project(code), undefined, code);
});

test("mixed or ambiguous executable operations veto discovery-only classification", () => {
  for (const code of [
    'await describeNamespace("mcp__docs"); await tools.read({path: "file"});',
    'await describeNamespace("mcp__docs"); await models.classify(model, input);',
    'await describeNamespace("mcp__docs"); await unknownCall();',
    'await describeNamespace("mcp__docs"); new Constructor();',
    'await describeNamespace("mcp__docs"); tagged`content`;',
    'text(await searchTools("query", { namespace: "mcp__docs", ...options }));',
    'const text = custom; text(await describeNamespace("mcp__docs"));',
    'console.log = value => tools.read({path: "file"}); console.log(await describeNamespace("mcp__docs"));',
    'Promise.all = custom; Promise.all([describeNamespace("mcp__docs")]);',
    'globalThis.console.log = custom; console.log(await describeNamespace("mcp__docs"));',
    'delete console.log; console.log(await describeNamespace("mcp__docs"));',
    'await describeNamespace("mcp__docs"); class Example { static { performWork(); } }',
  ])
    assert.equal(project(code)?.discoveryOnly, false, code);
});
