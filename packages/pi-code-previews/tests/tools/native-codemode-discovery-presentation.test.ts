import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings } from "../../testing";
import { compactStatus } from "../../src/tools/compact-summary";
import { nativeCall, scriptResult, settledSummary } from "../support/native-codemode";

const discovery = 'text(await describeNamespace("mcp__chrome_devtools"));';
const dispatch = (name = "read", status = "ok", id = "private/1") =>
  nativeCall({ id, name, status, args: '{"path":"/project/source.ts"}', durationMs: 4 });
const result = (calls: unknown[] = [], state = "completed") =>
  scriptResult(state, { calls }, { type: "text", text: "OUTPUT_HEAD\nOUTPUT_TAIL\nRECOVERY_TAIL" });
const summarize = (code: string, value: AgentToolResult<unknown>, isError = false) =>
  settledSummary(value, { code, isError });

beforeEach(() =>
  applyPresentationSettings({
    syntaxHighlighting: false,
    toolCallBackground: "off",
    toolCallTiming: false,
  }),
);

test("source intent cannot hide unavailable or incomplete ledgers or rewrite outcomes", () => {
  for (const details of [
    undefined,
    {},
    { calls: [null] },
    { calls: Array.from({ length: 257 }, () => dispatch()) },
  ]) {
    const projected = summarize(discovery, { ...result(), details })!;
    assert.equal(projected.outcome, "uncertain");
    assert.equal(
      projected.issues?.find((issue) => issue.code === "native-call-evidence-incomplete")?.severity,
      "warning",
    );
  }
  for (const status of ["running", "cancelled"])
    assert.equal(summarize(discovery, result([dispatch("read", status)]))?.outcome, "uncertain");
  assert.equal(summarize(discovery, result(), true)?.outcome, "uncertain");
  assert.equal(summarize(discovery, result([], "failed"), true)?.outcome, "error");
  assert.equal(summarize(discovery, result([dispatch("read", "error")]))?.outcome, "warning");
  assert.equal(
    summarize(discovery, {
      ...result(),
      content: [{ type: "text", text: "unknown native header" }],
    }),
    undefined,
  );
  assert.equal(compactStatus("settled", summarize(discovery, result())!), "success");
});
