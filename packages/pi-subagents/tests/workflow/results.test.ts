import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  readWorkflowResultLines,
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

  it("records a live call's usage, tool uses and duration, with the cost only when known", () => {
    const usage = { input: 900, output: 40, cacheRead: 60, cacheWrite: 0, totalTokens: 1_000 };
    expect(
      decode(
        workflowResultJsonLine(
          line({ usage: { ...usage, cost: 0.2 }, toolUses: 7, durationMs: 1_500 }),
        ),
      ),
    ).toMatchObject({
      usage: { input: 900, output: 40, total: 1_000, cost: 0.2 },
      toolUses: 7,
      durationMs: 1_500,
    });
    expect(decode(workflowResultJsonLine(line({ usage })))["usage"]).toEqual({
      input: 900,
      output: 40,
      total: 1_000,
    });
  });

  it("replays completed lines with and without usage alike", () => {
    const withUsage = workflowResultJsonLine(
      line({
        key: "k-1",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
        toolUses: 4,
        durationMs: 5,
      }),
    );
    const without = workflowResultJsonLine(line({ key: "k-2", runId: "agent-2" }));
    const reading = readWorkflowResultLines([withUsage, without]);
    expect(reading.finished).toBe(2);
    expect(reading.replayable).toEqual([
      expect.objectContaining({ key: "k-1", runId: "agent-1", outputTokens: 12 }),
      expect.objectContaining({ key: "k-2", runId: "agent-2", outputTokens: 12 }),
    ]);
  });

  it("leaves worktrees discarded as unchanged out of the ones left for recovery", () => {
    const reading = readWorkflowResultLines([
      workflowResultJsonLine(line({ key: "k-1", workspaceId: "workspace-1", unchanged: true })),
      workflowResultJsonLine(line({ key: "k-2", runId: "agent-2", workspaceId: "workspace-2" })),
    ]);
    expect(reading.workspaces).toEqual(["workspace-2"]);
    // Nothing of the writer's awaits review, so a resume reuses its result like a reader's.
    expect(reading.replayable[0]).toMatchObject({ key: "k-1" });
    expect(reading.replayable[0]?.workspaceId).toBeUndefined();
    expect(reading.replayable[1]).toMatchObject({ key: "k-2", workspaceId: "workspace-2" });
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
