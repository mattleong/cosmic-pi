import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import { applyPresentationSettings } from "../../testing";
import {
  codemodeSubject as subject,
  nativeCall,
  nativeReceipt as receipt,
  scriptResult,
  settledSummary as summarize,
} from "../support/native-codemode";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

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
    assert.equal(
      projected.subject,
      Fn.pipe(name, Str.slice("mcp__".length), Str.replace("__", " / ")),
    );
    assert.deepEqual(subject(name, { server: "spoofed", tool: "guessed" }), projected);
  }
  assert.equal(
    nativeCodemodeCallSubject("mcp__docs__lookup", nativeArgumentPreview("broken"), "/project")
      .subject,
    "docs / lookup",
  );
});

test("resource subjects and expanded argument previews redact complete and cut credentials", () => {
  for (const args of [
    { server: "docs", uri: "https://user:private-value@host/path" },
    { server: "docs", uri: `https://user:${Fn.pipe("private-value", Str.repeat(40))}@host/path` },
    { server: "docs", uri: "https://host/path?token=private-value" },
    { server: "docs", uri: "docs://guide", password: "private-value" },
  ]) {
    const result = completed([call("read_mcp_resource", receipt(args))]);
    const row = summarize(result)?.children?.entries[0];
    assert.ok(row);
    assert.equal(Fn.pipe(JSON.stringify(row), Str.includes("private-value")), false);
    assert.ok(row.issues);
    assert.ok(Arr.some(row.issues, (issue) => issue.code === "native-call-args"));
  }
});
