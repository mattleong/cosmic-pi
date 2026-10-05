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

test("generic or dynamic targets never acquire guessed MCP specificity", () => {
  for (const code of [
    'text(await describeTool("read"));',
    'text(await describeNamespace("workspace"));',
    'text(await searchTools("Chrome DevTools MCP"));',
    "text(await describeTool(toolName));",
    "text(await describeNamespace(`mcp__${server}`));",
    'text(await describeNamespace("mcp__" + server));',
    'text(await searchTools("query", { namespace: variable }));',
    'text(await searchTools("query", { namespace: "mcp__docs", namespace: "other" }));',
    'text(await searchTools("query", { ["namespace"]: "mcp__docs" }));',
    'text(await searchTools("query", { get namespace() { return "mcp__docs"; } }));',
  ])
    assert.equal(project(code)?.kind, "tools", code);
  const mixed = project('await describeTool("read"); await tools.mcp__docs__lookup({});');
  assert.deepEqual(mixed, { kind: "tools", discoveryOnly: false });
});

test("inert text, unrelated methods, aliases and uncalled definitions are not discovery sites", () => {
  for (const code of [
    '// await describeTool("mcp__docs__lookup")\ntext("plain");',
    '/* describeNamespace("mcp__docs") */ text("plain");',
    'text("describeNamespace(\\\"mcp__docs\\\")");',
    'text(/describeNamespace("mcp__docs")/);',
    'text(`describeNamespace("mcp__docs")`);',
    'text(await object.describeTool("mcp__docs__lookup"));',
    'text(await tools.describeTool("mcp__docs__lookup"));',
    'text(await object["describeNamespace"]("mcp__docs"));',
    'const lookup = describeTool; text(await lookup("mcp__docs__lookup"));',
    'text(await describeTool.call(null, "mcp__docs__lookup"));',
    'async function unused() { await describeTool("mcp__docs__lookup"); } text("plain");',
    'const unused = async () => describeNamespace("mcp__docs"); text("plain");',
    'const object = { async describe() { await describeNamespace("mcp__docs"); } };',
    'class Unused { async describe() { await describeNamespace("mcp__docs"); } }',
    'await searchTools?.("query");',
    'text(ALL_TOOLS.filter(tool => tool.name.startsWith("mcp__")));',
  ])
    assert.equal(project(code), undefined, code);
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

test("class initialization sites are active but inert methods and instance initializers are not", () => {
  for (const code of [
    'class Work { static { describeNamespace("mcp__docs"); } }',
    'class Work { static metadata = describeNamespace("mcp__docs"); }',
    'class Work { [describeNamespace("mcp__docs")]() {} }',
    'class Work extends describeNamespace("mcp__docs") {}',
  ])
    assert.deepEqual(project(code), { kind: "mcp", discoveryOnly: false });
  assert.equal(project('class Work { metadata = describeNamespace("mcp__docs"); }'), undefined);
  assert.equal(
    project('class Work { static metadata() { describeNamespace("mcp__docs"); } }'),
    undefined,
  );
});

test("source intent is not an execution trace of conditional branches", () => {
  assert.equal(project('if (condition) await describeNamespace("mcp__docs");')?.kind, "mcp");
});

test("invalid, oversized, deeply nested, and unreadable source gets no guessed hint", () => {
  for (const code of [
    'await describeNamespace("mcp__docs"',
    "// " + "x".repeat(32768) + '\nawait describeNamespace("mcp__docs");',
    "(".repeat(150) + 'describeNamespace("mcp__docs")' + ")".repeat(150),
    'await describeNamespace("mcp__docs");' + "text(1);".repeat(1500),
  ])
    assert.equal(project(code), undefined);
  const classify = createNativeDiscoveryProjector();
  assert.equal(classify({ code: 3 }), undefined);
  let reads = 0;
  assert.equal(
    classify(
      Object.defineProperty({}, "code", {
        get() {
          reads++;
          throw new Error("getter");
        },
      }),
    ),
    undefined,
  );
  assert.equal(reads, 0);
});

test("one projector follows changed source without changing the supplied arguments", () => {
  const classify = createNativeDiscoveryProjector();
  const args = { code: 'text(await describeNamespace("mcp__docs"));' };
  const before = structuredClone(args);
  assert.equal(classify(args)?.kind, "mcp");
  assert.equal(classify({ ...args })?.kind, "mcp");
  assert.deepEqual(args, before);
  args.code = 'text(await describeTool("read"));';
  assert.equal(classify(args)?.kind, "tools");
  assert.equal(classify({ code: "return 1;" }), undefined);
});
