import assert from "node:assert/strict";
import { test } from "vitest";
import { issueMessageStyleProblems, renderContextFixture } from "../../testing";
import { compactStatus, type CompactSummary } from "../../src/tools/compact-summary";
import { nativeMcpIdentity } from "../../src/tools/native-mcp-identity";
import { nativeMcpSummary } from "../../src/tools/native-mcp-summary";
import { scriptResult, settledSummary } from "../support/native-codemode";

const header =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n";
const saved = "\n\n[Full output: /tmp/full.txt (read with offset/limit)]";
const unsaved = "\n\n[Could not save the full output: ENOSPC: disk full]";

const recovery = (fullOutputPath: string | undefined) =>
  fullOutputPath === undefined ? {} : { fullOutputPath };

const codemode = (text: string, fullOutputPath?: string) =>
  settledSummary(
    scriptResult("completed", { calls: [], ...recovery(fullOutputPath) }, { type: "text", text }),
  );

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
    { text: `${header}HEAD${saved}\nTAIL${unsaved}`, path: undefined, expected: lost },
    // A saved-output path cannot hide Pi saying the save failed.
    { text: `${header}HEAD…TAIL${unsaved}`, path: "/tmp/stale.txt", expected: lost },
    { text: `${header}HEAD…TAIL${unsaved}`, path: undefined, expected: lost },
    { text: `${header}HEAD…TAIL`, path: undefined, expected: [["output-truncated", "warning"]] },
  ]) {
    const lostOutput = expected.some(([, severity]) => severity === "warning");
    for (const [summary, delivered] of [
      [codemode(text, path), "success"],
      [mcp(text, path), "returned"],
    ] as const) {
      // Recoverable clipping is informational; lost output raises the row to a warning.
      assert.equal(compactStatus("settled", summary!), lostOutput ? "warning" : delivered);
      const projected = clipping(summary);
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
