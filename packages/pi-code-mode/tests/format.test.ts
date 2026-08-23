// Pure model-visible formatting: diagnostics, logs, and bounded progress containment.
import { describe, expect, it } from "vitest";
import {
  boundedCallEntries,
  callEntryDetails,
  formatCodeModeFailure,
  formatCodeModeSuccess,
  MAX_PROGRESS_ENTRIES,
  progressResult,
  type CodeModeCallEntry,
} from "../src/tools/format.ts";

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

  it("defensively copies bounded entries (including activity) so later mutation is not observable", () => {
    const calls: CodeModeCallEntry[] = [{ tool: "pi.read", status: "running", activity: "Read a" }];
    const bounded = boundedCallEntries(calls);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    (calls[0] as { status: string }).status = "completed";
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    (calls[0] as { activity: string }).activity = "Read b";
    expect(bounded[0]?.status).toBe("running");
    expect(bounded[0]?.activity).toBe("Read a");
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

  it("records the true total only when calls exceed the bounded entries", () => {
    const few: CodeModeCallEntry[] = [{ tool: "pi.read", status: "completed" }];
    expect(callEntryDetails(few)).toEqual({
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
    const many: CodeModeCallEntry[] = Array.from({ length: MAX_PROGRESS_ENTRIES + 8 }, () => ({
      tool: "pi.read",
      status: "completed" as const,
    }));
    const details = callEntryDetails(many);
    expect(details.toolCalls).toHaveLength(MAX_PROGRESS_ENTRIES);
    expect(details.totalToolCalls).toBe(MAX_PROGRESS_ENTRIES + 8);
  });
});
