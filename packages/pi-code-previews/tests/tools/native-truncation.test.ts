import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { issueMessageStyleProblems, renderContextFixture } from "../../testing";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";
import { nativeMcpIdentity } from "../../src/tools/native-mcp-identity";
import { nativeMcpSummary } from "../../src/tools/native-mcp-summary";

const header =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n";
const saved = "\n\n[Full output: /tmp/full.txt (read with offset/limit)]";
const unsaved = "\n\n[Could not save the full output: ENOSPC: disk full]";

const recovery = (fullOutputPath: string | undefined) =>
  fullOutputPath === undefined ? {} : { fullOutputPath };

function codemode(text: string, fullOutputPath?: string) {
  const result: AgentToolResult<unknown> = {
    content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text },
    ],
    details: { calls: [], ...recovery(fullOutputPath) },
  };
  return nativeCodemodeSummary("/project")({
    phase: "settled",
    args: { code: "" },
    result,
    context: renderContextFixture({ isPartial: false, executionStarted: true }),
  });
}

function mcp(text: string, fullOutputPath?: string) {
  const identity = nativeMcpIdentity("mcp__docs__lookup", { namespace: { name: "mcp__docs" } });
  return nativeMcpSummary(identity)({
    phase: "settled",
    args: {},
    result: {
      content: [{ type: "text", text }],
      details: { server: "docs", tool: "lookup", ...recovery(fullOutputPath) },
    },
    context: renderContextFixture({ isPartial: false, executionStarted: true }),
  });
}

/** Clipping issues without the producer's code prefix. */
const clipping = (summary: CompactSummary | undefined) =>
  (summary?.issues ?? [])
    .filter((issue) => /-output-(truncated|save-failed)$/.test(issue.code))
    .map((issue) => ({
      kind: issue.code.replace(/^(native|mcp)-/, ""),
      severity: issue.severity,
      message: issue.message,
      detail: issue.detail ?? "",
    }));

test("codemode and MCP read Pi's truncation envelope the same way", () => {
  const lost = [
    ["output-truncated", "warning"],
    ["output-save-failed", "warning"],
  ];
  for (const { text, path, expected } of [
    {
      text: `${header}HEAD…TAIL${saved}`,
      path: "/tmp/full.txt",
      expected: [["output-truncated", "info"]],
    },
    // A kept body may quote another envelope's footer; only Pi's final footer is recovery.
    {
      text: `${header}HEAD${unsaved}\nTAIL${saved}`,
      path: "/tmp/full.txt",
      expected: [["output-truncated", "info"]],
    },
    // A saved-output path cannot hide Pi saying the save failed.
    { text: `${header}HEAD…TAIL${unsaved}`, path: "/tmp/stale.txt", expected: lost },
    { text: `${header}HEAD…TAIL${unsaved}`, path: undefined, expected: lost },
    { text: `${header}HEAD…TAIL`, path: undefined, expected: [["output-truncated", "warning"]] },
  ]) {
    const issues = [clipping(codemode(text, path)), clipping(mcp(text, path))];
    for (const projected of issues) {
      assert.deepEqual(
        projected.map(({ kind, severity }) => [kind, severity]),
        expected,
        text,
      );
      for (const issue of projected) {
        assert.deepEqual(issueMessageStyleProblems(issue.message), []);
        if (issue.kind === "output-save-failed") assert.ok(issue.detail.includes("ENOSPC"));
        if (issue.severity === "info") assert.ok(issue.detail.includes("/tmp/full.txt"));
      }
    }
  }
});
