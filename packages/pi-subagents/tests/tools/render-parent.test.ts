import type { CompactSummary } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { MAX_PARENT_MESSAGE_CHARS } from "../../src/run/limits.ts";
import { contactParentCompactSummary } from "../../src/tools/render-parent.ts";

interface ContactArguments {
  kind?: string;
  message?: string;
}

function summarize(args: ContactArguments, text?: string | string[], isError = false) {
  const content = [text ?? []].flat().map((part) => ({ type: "text" as const, text: part }));
  return contactParentCompactSummary({
    args,
    phase: text === undefined ? "running" : "settled",
    result: text === undefined ? undefined : { content, details: {} },
    context: renderContextFixture({ isError }),
  });
}

/** Everything a summary says: its heading subject and its issue lines. */
const evidence = (summary: CompactSummary | undefined) =>
  [summary?.subject, ...(summary?.issues ?? []).map((issue) => issue.message)].join("\n");

describe("child compact acknowledgement policy", () => {
  it("summarizes valid live requests without claiming delivery", () => {
    for (const kind of ["progress", "warning", "question"]) {
      const summary = summarize({ kind, message: "Cleanup is incomplete" });
      expect(summary).toBeDefined();
      expect(summary?.outcome).toBe(kind === "warning" ? "warning" : undefined);
      // A warning's text is its issue line; other requests head the row with it.
      expect(evidence(summary)).toContain("Cleanup is incomplete");
    }
    expect(summarize({ kind: "unknown", message: "x" })).toBeUndefined();
    const oversized = "x".repeat(MAX_PARENT_MESSAGE_CHARS + 1);
    expect(summarize({ kind: "progress", message: oversized })).toBeUndefined();
  });

  it("collapses only exact owned acknowledgements and leaves replies and errors intact", () => {
    for (const kind of ["progress", "warning"]) {
      const args = { kind, message: "working" };
      const receipt = `Parent received ${kind}.`;
      expect(summarize(args, receipt)?.outcome).toBe(kind === "warning" ? "warning" : "success");
      expect(summarize(args, `${receipt} Important recovery instructions`)).toBeUndefined();
      // Additional content is never discarded beside a recognized acknowledgement.
      expect(summarize(args, [receipt, "Recovery evidence"])).toBeUndefined();
      // A rejected call keeps its heading and explains itself; its text stays expanded.
      const rejected = summarize(args, "Parent contact is unavailable for this session.", true);
      expect(rejected?.outcome).toBe("error");
      expect(rejected?.issues?.some((issue) => issue.severity === "error")).toBe(true);
    }
    const question = { kind: "question", message: "continue?" };
    expect(summarize(question, "Parent received question.")).toBeUndefined();
    // A reply to a question is classified as answered.
    expect(summarize(question, "Parent reply: continue")?.outcome).toBe("success");
    expect(summarize(question, ["Parent reply: continue", "extra"])).toBeUndefined();
    expect(summarize(question, "An unrelated result")).toBeUndefined();
  });

  it("preserves complete warnings while keeping child subjects bounded", () => {
    const message = "Verify cleanup before retry. ".repeat(30);
    expect(summarize({ kind: "progress", message })?.subject.length).toBeLessThanOrEqual(120);
    const summary = summarize({ kind: "warning", message }, "Parent received warning.");
    expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["warning"]);
    // The warning quotes its own bounded first line and keeps the full text expanded.
    expect(summary?.issues?.[0]?.message.length).toBeLessThanOrEqual(120);
    expect(issueMessageStyleProblems(summary?.issues?.[0]?.message ?? "")).toEqual([]);
    expect(summary?.issues?.[0]?.detail).toBe(message);
    // Text that opens with an instruction is not quoted as the message.
    const guidance = summarize(
      { kind: "warning", message: "Use the fallback route before retrying." },
      "Parent received warning.",
    );
    expect(guidance?.issues?.[0]?.message).not.toContain("fallback route");
    expect(
      summarize({ kind: "progress", message: "\u001b[31mchecking\nfiles" })?.subject,
    ).not.toContain("\u001b");
  });
});
