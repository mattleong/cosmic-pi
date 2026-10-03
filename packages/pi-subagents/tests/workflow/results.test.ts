import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_RESULT_LINE_MAX_CHARS,
  workflowResultJsonLine,
  type WorkflowResultLine,
} from "../../src/workflow/results.ts";

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const line = (patch: Partial<WorkflowResultLine> = {}): WorkflowResultLine => ({
  callId: 1,
  label: "finder",
  phase: "Find",
  state: "completed",
  runId: "agent-1",
  outputTokens: 12,
  result: { bugs: ["a.ts:3"] },
  ...patch,
});

describe("results journal lines", () => {
  it("records a call on one line with its result verbatim", () => {
    const text = workflowResultJsonLine(line({ result: { note: "two\nlines" } }));
    expect(text).not.toContain("\n");
    expect(decode(text)).toEqual({
      callId: 1,
      label: "finder",
      phase: "Find",
      state: "completed",
      runId: "agent-1",
      outputTokens: 12,
      result: { note: "two\nlines" },
    });
  });

  it("marks a reused or failed call and leaves out what it doesn't have", () => {
    expect(
      decode(
        workflowResultJsonLine(
          line({ callId: undefined, reused: true, phase: undefined, result: "cached" }),
        ),
      ),
    ).toEqual({
      label: "finder",
      state: "completed",
      reused: true,
      runId: "agent-1",
      outputTokens: 12,
      result: "cached",
    });
    expect(
      decode(workflowResultJsonLine(line({ state: "failed", reason: "timeout", result: null }))),
    ).toMatchObject({ state: "failed", reason: "timeout", result: null });
  });

  it("bounds a long text result to its head and says how long it was", () => {
    const text = "é".repeat(WORKFLOW_RESULT_LINE_MAX_CHARS * 2);
    const decoded = decode(workflowResultJsonLine(line({ result: text })));
    expect(decoded["resultTruncated"]).toBe(true);
    expect(decoded["resultChars"]).toBe(text.length);
    const head = Schema.decodeUnknownSync(Schema.String)(decoded["result"]);
    expect(text.startsWith(head)).toBe(true);
    expect(JSON.stringify(head).length).toBeLessThanOrEqual(WORKFLOW_RESULT_LINE_MAX_CHARS);
  });

  it("bounds a large value to the head of its JSON", () => {
    const value = { items: Array.from({ length: 20_000 }, (_, index) => `item-${index}`) };
    const decoded = decode(workflowResultJsonLine(line({ result: value })));
    expect(decoded["resultTruncated"]).toBe(true);
    const head = Schema.decodeUnknownSync(Schema.String)(decoded["result"]);
    expect(JSON.stringify(value).startsWith(head)).toBe(true);
    expect(head.length).toBeLessThanOrEqual(WORKFLOW_RESULT_LINE_MAX_CHARS);
  });
});
