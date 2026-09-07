// Pure model-visible formatting: diagnostics, logs, and bounded progress containment.
import { describe, expect, it } from "vitest";
import {
  callEntryDetails,
  describeNestedActivity,
  formatCodeModeFailure,
  formatCodeModeSuccess,
  formatForeignRejection,
  MAX_ACTIVITY_FIELD_LENGTH,
  MAX_PROGRESS_ENTRIES,
  progressResult,
  type CodeModeCallEntry,
} from "../src/tools/format.ts";

describe("defensive formatters", () => {
  it("normalizes foreign rejections without escaping hostile coercion", () => {
    const hostile = {
      toString: () => {
        throw new Error("toString escaped");
      },
    };
    expect(formatForeignRejection(new Error("ordinary"))).toBe("ordinary");
    expect(formatForeignRejection("string")).toBe("string");
    expect(formatForeignRejection(hostile)).toBe("Unknown rejection");
  });

  it("derives categorized, bounded activity from decoded inputs", () => {
    const cases = [
      ["pi.read", { path: "src/a.ts" }, /^Read\b/, ["src/a.ts"]],
      ["pi.grep", { pattern: "TODO" }, /^Search\b/, ["TODO"]],
      ["pi.powershell", { command: "Get-ChildItem" }, /^Run\b/, ["Get-ChildItem"]],
      ["session.backgroundTask", { action: "wait", id: "bg-2" }, /^Background\b/, ["wait", "bg-2"]],
    ] as const;
    for (const [name, input, category, fields] of cases) {
      const activity = describeNestedActivity(name, input);
      expect(activity).toMatch(category);
      for (const field of fields) expect(activity).toContain(field);
      expect([...activity].length).toBeLessThanOrEqual(MAX_ACTIVITY_FIELD_LENGTH * 2 + 20);
    }

    const longPath = "x".repeat(MAX_ACTIVITY_FIELD_LENGTH * 3);
    const bounded = describeNestedActivity("pi.read", { path: longPath });
    expect([...bounded].length).toBeLessThanOrEqual(MAX_ACTIVITY_FIELD_LENGTH + "Read ".length);
    expect(bounded).not.toContain(longPath);
  });
});

describe("formatCodeModeSuccess", () => {
  it("returns string values verbatim and appends logs", () => {
    expect(formatCodeModeSuccess({ ok: true, value: "hello", logs: ["one", "two"] }, 51_200)).toBe(
      "hello\n\nLogs:\none\ntwo",
    );
  });

  it("pretty-prints structured values while they fit maxOutputBytes", () => {
    expect(formatCodeModeSuccess({ ok: true, value: { a: 1 } }, 51_200)).toBe(
      JSON.stringify({ a: 1 }, null, 2),
    );
  });

  it("falls back to the runtime-bounded compact form when pretty output would exceed maxOutputBytes", () => {
    // 64 one-byte entries: compact is well under the limit, pretty expansion is not.
    const value = Array.from({ length: 64 }, () => "x");
    const compact = JSON.stringify(value);
    const limit = compact.length + 8;
    expect(JSON.stringify(value, null, 2).length).toBeGreaterThan(limit);
    expect(formatCodeModeSuccess({ ok: true, value }, limit)).toBe(compact);
  });
});

describe("formatCodeModeFailure", () => {
  it("preserves the normalized diagnostic kind, location, suggestions, and logs", () => {
    const message = formatCodeModeFailure({
      ok: false,
      error: {
        kind: "UnknownTool",
        message: "Unknown tool 'pi.missing'.",
        location: { line: 2, column: 7 },
        suggestions: ["Use tools.$codemode.search({ query }) to find available described tools."],
      },
      logs: ["probe"],
    });
    expect(message).toContain("[UnknownTool]");
    expect(message).toContain("(line 2, column 7)");
    expect(message).toContain("Unknown tool 'pi.missing'.");
    expect(message).toContain("$codemode.search");
    expect(message).toContain("Logs:\nprobe");
  });

  it("drops suggestions already contained in the message", () => {
    const message = formatCodeModeFailure({
      ok: false,
      error: {
        kind: "ToolFailure",
        message: "refused: narrow the call",
        suggestions: ["narrow the call"],
      },
    });
    expect(message).toBe("[ToolFailure] refused: narrow the call");
  });
});

describe("progress containment", () => {
  it("stays bounded and never contains nested tool output", () => {
    const calls: CodeModeCallEntry[] = Array.from({ length: 100 }, (_, index) => ({
      tool: `pi.read`,
      status: index % 2 === 0 ? ("completed" as const) : ("running" as const),
    }));
    const partial = progressResult(calls);
    expect(partial.details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(partial.content).toHaveLength(1);
    const text = partial.content[0]?.type === "text" ? partial.content[0].text : "";
    expect(text).toContain("100 nested tool calls (50 settled, 50 running, 0 queued)");
    expect(text).toContain("+68 earlier");
    expect(text.length).toBeLessThan(2_000);
  });

  it("reports hidden rows from exact counts when the supplied rows were already retained", () => {
    const retained: CodeModeCallEntry[] = Array.from(
      { length: MAX_PROGRESS_ENTRIES },
      () => ({ tool: "pi.read", status: "completed" }) as const,
    );
    const partial = progressResult(retained, {
      total: 100,
      queued: 0,
      running: 0,
      succeeded: 100,
      failed: 0,
      cancelled: 0,
    });
    const text = partial.content[0]?.type === "text" ? partial.content[0].text : "";
    expect(text).toContain("100 nested tool calls (100 settled, 0 running, 0 queued)");
    expect(text).toContain("+68 earlier");
    expect(partial.details.counts?.total).toBe(100);
    expect(partial.details.totalToolCalls).toBe(100);
  });

  it("keeps problem and active rows plus recent successes beyond the display bound", () => {
    const calls: CodeModeCallEntry[] = [
      ...Array.from({ length: 40 }, (_, index) => ({
        tool: `pi.read-${index}`,
        status: "completed" as const,
      })),
      { tool: "pi.grep", status: "running" as const },
      { tool: "pi.edit", status: "error" as const },
    ];
    const details = callEntryDetails(calls);
    expect(details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(details.toolCalls.some((call) => call.tool === "pi.grep")).toBe(true);
    expect(details.toolCalls.some((call) => call.tool === "pi.edit")).toBe(true);
    expect(details.toolCalls.some((call) => call.tool === "pi.read-39")).toBe(true);
    expect(details.toolCalls.some((call) => call.tool === "pi.read-0")).toBe(false);
    expect(details.counts).toMatchObject({ total: 42, running: 1, failed: 1, succeeded: 40 });
  });

  it("keeps only the latest noncompleted rows when they exceed the display bound", () => {
    const statuses = ["queued", "running", "error", "cancelled"] as const;
    const problems: CodeModeCallEntry[] = Array.from({ length: 40 }, (_, index) => ({
      tool: `problem-${index}`,
      status: statuses[index % statuses.length] ?? "error",
    }));
    const calls: CodeModeCallEntry[] = [
      ...problems,
      { tool: "latest-success", status: "completed" },
    ];
    const details = callEntryDetails(calls);
    expect(details.toolCalls).toEqual(problems.slice(-MAX_PROGRESS_ENTRIES));
    for (const row of details.toolCalls) expect(calls).not.toContain(row);
    expect(details.counts).toMatchObject({ total: 41, succeeded: 1 });
  });

  it("fills around interleaved problem rows with recent successes in chronological order", () => {
    const calls: CodeModeCallEntry[] = Array.from({ length: 40 }, (_, index) => ({
      tool: `call-${index}`,
      status:
        index === 0 ? "error" : index === 20 ? "queued" : index === 38 ? "cancelled" : "completed",
    }));
    const details = callEntryDetails(calls);
    expect(details.toolCalls).toEqual([calls[0], ...calls.slice(9)]);
    for (const row of details.toolCalls) expect(calls).not.toContain(row);
    expect(details.counts).toMatchObject({
      total: 40,
      succeeded: 37,
      failed: 1,
      queued: 1,
      cancelled: 1,
    });
  });

  it("retains the legacy total only when rows are hidden", () => {
    const few: CodeModeCallEntry[] = [{ tool: "pi.read", status: "completed" }];
    const fewDetails = callEntryDetails(few);
    expect(fewDetails).toEqual({
      toolCalls: few,
      counts: {
        total: 1,
        queued: 0,
        running: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
      },
    });
    expect(fewDetails.toolCalls[0]).not.toBe(few[0]);
    const many: CodeModeCallEntry[] = Array.from({ length: MAX_PROGRESS_ENTRIES + 8 }, () => ({
      tool: "pi.read",
      status: "completed" as const,
    }));
    const details = callEntryDetails(many);
    expect(details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(details.toolCalls.at(-1)).not.toBe(many.at(-1));
    expect(details.counts?.total).toBe(MAX_PROGRESS_ENTRIES + 8);
    expect(details.totalToolCalls).toBe(MAX_PROGRESS_ENTRIES + 8);
  });
});
