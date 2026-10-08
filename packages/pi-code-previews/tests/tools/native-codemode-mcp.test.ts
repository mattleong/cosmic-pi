import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  issueMessageStyleProblems,
} from "../../testing";
import {
  codemodeRenderers,
  codemodeSubject as subject,
  nativeCall,
  nativeReceipt as receipt,
  scriptResult,
  settledSummary as summarize,
} from "../support/native-codemode";

const completed = (calls: unknown[]) =>
  scriptResult(
    "completed",
    { calls },
    { type: "text", text: "OUTPUT_RETAINED" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  );
const call = (name: string, args = "{}", status = "ok") => nativeCall({ name, args, status });
beforeEach(() =>
  applyPresentationSettings({ syntaxHighlighting: false, toolCallBackground: "off" }),
);

test("native MCP registered aliases provide targets without recovering remote identifiers", () => {
  for (const name of [
    "mcp__docs__lookup",
    "mcp__atlassian__tool_call",
    "mcp__team-docs__find_page",
    "mcp__docs__lookup_1234abcd",
  ]) {
    const projected = subject(name);
    assert.equal(projected.label, "mcp");
    assert.equal(projected.action, "call");
    assert.equal(projected.subject, name.slice("mcp__".length).replace("__", " / "));
    // Input fields cannot override the target assigned by the registered name.
    assert.deepEqual(subject(name, { server: "spoofed", tool: "guessed" }), projected);
  }
  assert.equal(
    nativeCodemodeCallSubject("mcp__docs__lookup", nativeArgumentPreview("broken"), "/project")
      .subject,
    "docs / lookup",
  );
});

test("ambiguous or malformed MCP names and unrelated tools retain their original labels", () => {
  for (const name of [
    "mcp__team__docs__lookup",
    "mcp__docs___lookup",
    "mcp___docs__lookup",
    "mcp__docs__lookup_",
    "mcp__docs__",
    "mcp__docs__lookup.invalid",
    `mcp__${"x".repeat(65)}__lookup`,
    `mcp__${"x".repeat(49)}__c2936b33`,
    "mcp__My_Docs__production_knowledge_base_for_the_EU_regi_3f2127c4",
    "custom_lookup",
  ]) {
    const result = completed([call(name)]);
    const row = summarize(result)?.children?.entries[0];
    assert.equal(row?.label, name);
    assert.equal(row?.subject, "");
    assert.equal(row?.action, undefined);
    if (name.startsWith("mcp__"))
      assert.ok(
        row?.issues?.some((issue) => issue.code === "native-call-name" && issue.detail === name),
      );
  }
});

test("native resource rows use only observed root arguments without fabricated defaults", () => {
  assert.deepEqual(subject("read_mcp_resource", { server: "docs", uri: "docs://guide/start" }), {
    label: "mcp",
    action: "read resource",
    subject: "docs / docs://guide/start",
  });
  for (const name of ["list_mcp_resources", "list_mcp_resource_templates"]) {
    assert.equal(subject(name, { server: "docs", cursor: "private-cursor" }).subject, "docs");
    assert.equal(subject(name, {}).subject, "");
    assert.equal(subject(name).subject, "");
    assert.equal(subject(name, { payload: { server: "nested" } }).subject, "");
    assert.equal(subject(name).label, "mcp");
  }
  const args = { uri: "docs://guide/" + "x".repeat(400), server: "past-the-cut" };
  const projected = subject("read_mcp_resource", args);
  assert.ok(projected.subject?.startsWith("docs://guide/"));
  assert.ok(projected.subject?.endsWith("…"));
  assert.equal(projected.subject?.includes("past-the-cut"), false);
  assert.equal(
    subject("read_mcp_resource", { server: "docs", payload: "x".repeat(400), uri: "hidden" })
      .subject,
    "docs",
  );
});

test("resource subjects and expanded argument previews redact complete and cut credentials", () => {
  for (const args of [
    { server: "docs", uri: "https://user:private-value@host/path" },
    { server: "docs", uri: `https://user:${"private-value".repeat(40)}@host/path` },
    { server: "docs", uri: "https://host/path?token=private-value" },
    { server: "docs", uri: "docs://guide", password: "private-value" },
  ]) {
    const result = completed([call("read_mcp_resource", receipt(args))]);
    const row = summarize(result)?.children?.entries[0];
    assert.ok(row);
    assert.equal(JSON.stringify(row).includes("private-value"), false);
    assert.ok(row.issues?.some((issue) => issue.code === "native-call-args"));
  }
});

test("MCP child delivery stays neutral and original call identity survives expansion", () => {
  const name = "mcp__docs__lookup_1234abcd";
  const result = completed([call(name, receipt({ query: "lookup query" }))]);
  const before = structuredClone(result);
  const summary = summarize(result);
  const row = summary?.children?.entries[0];
  assert.equal(row?.status, "returned");
  assert.equal(row?.returnedCheckmark, true);
  assert.ok(
    row?.issues?.some((issue) => issue.code === "native-call-name" && issue.detail === name),
  );
  assert.ok(
    row?.issues?.some(
      (issue) => issue.code === "native-call-args" && issue.detail?.includes("lookup query"),
    ),
  );
  assert.deepEqual(result, before);
});

test("MCP failures, cancellations and unfinished calls retain their existing classifications", () => {
  const diagnostic = "MCP server docs requires sign-in. Run /mcp to sign in.";
  const failed = completed([{ ...call("mcp__docs__lookup", "{}", "error"), error: diagnostic }]);
  const summary = summarize(failed);
  assert.equal(summary?.outcome, "warning");
  const row = summary?.children?.entries[0];
  assert.equal(row?.status, "error");
  assert.ok(
    row?.issues?.some((issue) => issue.severity === "error" && issue.detail === diagnostic),
  );
  for (const issue of [...(summary?.issues ?? []), ...(row?.issues ?? [])])
    assert.deepEqual(issueMessageStyleProblems(issue.message), []);
  assert.equal(
    row?.issues?.find((issue) => issue.severity === "error")?.message.includes("Run /mcp"),
    false,
  );
  for (const status of ["cancelled", "running"]) {
    const uncertain = summarize(completed([call("mcp__docs__lookup", "{}", status)]));
    assert.equal(uncertain?.outcome, "uncertain");
    assert.equal(
      uncertain?.children?.entries[0]?.status,
      status === "running" ? "uncertain" : status,
    );
  }
});

for (const style of ["compact", "preview"] as const)
  test(`MCP ${style} expansion retains program, registered alias, arguments, errors and output`, () => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    const styled = codemodeRenderers();
    const name = "mcp__docs__lookup_1234abcd";
    const result = completed([
      {
        ...call(name, receipt({ query: "QUERY_RETAINED" }), "error"),
        error: "ERROR_RETAINED. Run /mcp to recover.",
      },
    ]);
    const before = structuredClone(result);
    const h = createToolPresentationHarness(styled);
    h.call({ code: "// PROGRAM_RETAINED" });
    h.result(result);
    h.render(60);
    h.call({ code: "// PROGRAM_RETAINED" }, { expanded: true });
    h.result(result, { expanded: true });
    const expanded = h.render(120).join("\n");
    for (const marker of [
      "PROGRAM_RETAINED",
      name,
      "QUERY_RETAINED",
      "ERROR_RETAINED",
      "Run /mcp",
      "OUTPUT_RETAINED",
    ])
      assert.ok(expanded.includes(marker), marker);
    assert.deepEqual(result, before);
  });
