import type { CompactSummary } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "vitest";
import { createParentCompactSummary } from "../../src/tools/compact-parent-summary.ts";

interface ParentArguments {
  kind?: string;
  message?: string;
  delivery_id?: string;
  report?: string;
}

function summarize(name: string, args: ParentArguments, text?: string | string[], isError = false) {
  const provider = createParentCompactSummary(name);
  const content = [text ?? []].flat().map((part) => ({ type: "text" as const, text: part }));
  return provider({
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
      const summary = summarize("contact_parent", { kind, message: "Cleanup is incomplete" });
      expect(summary).toBeDefined();
      expect(summary?.outcome).toBe(kind === "warning" ? "warning" : undefined);
      // A warning's text is its issue line; other requests head the row with it.
      expect(evidence(summary)).toContain("Cleanup is incomplete");
    }
    expect(summarize("contact_parent", { kind: "unknown", message: "x" })).toBeUndefined();
    expect(summarize("supervisor_progress", { message: "x".repeat(20_000) })).toBeUndefined();
    expect(summarize("supervisor_submit_report", { report: "done" })).toBeUndefined();
  });

  it("collapses only exact owned acknowledgements and leaves replies and errors intact", () => {
    const receipts = [
      ["contact_parent", { kind: "progress", message: "working" }, "Parent received progress."],
      ["contact_parent", { kind: "warning", message: "risk" }, "Parent received warning."],
      [
        "supervisor_progress",
        { message: "working" },
        "Progress delivered to the parent projection.",
      ],
      ["supervisor_warning", { message: "risk" }, "Warning recorded in parent-visible run status."],
      [
        "supervisor_submit_report",
        { delivery_id: "report-1", report: "done" },
        "Final report accepted; sequence 1.",
      ],
    ] as const;
    for (const [name, args, receipt] of receipts) {
      expect(summarize(name, args, receipt)?.outcome).toBe(
        name.includes("warning") || ("kind" in args && args.kind === "warning")
          ? "warning"
          : "success",
      );
      expect(summarize(name, args, `${receipt} Important recovery instructions`)).toBeUndefined();
      // A rejected call keeps its heading and explains itself; its text stays expanded.
      const rejected = summarize(
        name,
        args,
        "Parent contact is unavailable for this session.",
        true,
      );
      expect(rejected?.outcome).toBe("error");
      expect(rejected?.issues?.some((issue) => issue.severity === "error")).toBe(true);
    }
    expect(
      summarize(
        "contact_parent",
        { kind: "question", message: "continue?" },
        "Parent received question.",
      ),
    ).toBeUndefined();
    // Every child transport's reply to a question is classified as answered.
    for (const [name, args] of [
      ["supervisor_question", { message: "continue?" }],
      ["contact_parent", { kind: "question", message: "continue?" }],
    ] as const) {
      expect(summarize(name, args, "Parent reply: continue")?.outcome).toBe("success");
      expect(summarize(name, args, ["Parent reply: continue", "extra"])).toBeUndefined();
      expect(summarize(name, args, "An unrelated result")).toBeUndefined();
    }
  });

  it("preserves complete warnings while keeping child subjects bounded", () => {
    const message = "Verify cleanup before retry. ".repeat(30);
    const summary = summarize(
      "supervisor_warning",
      { message },
      "Warning recorded in parent-visible run status.",
    );
    expect(summary?.subject.length).toBeLessThanOrEqual(120);
    expect(summary?.action).toBeUndefined();
    expect(summary?.issues?.map((issue) => issue.severity)).toEqual(["warning"]);
    // The warning quotes its own bounded first line and keeps the full text expanded.
    expect(summary?.issues?.[0]?.message.length).toBeLessThanOrEqual(120);
    expect(issueMessageStyleProblems(summary?.issues?.[0]?.message ?? "")).toEqual([]);
    expect(summary?.issues?.[0]?.detail).toBe(message);
    // Text that opens with an instruction is not quoted as the message.
    const guidance = summarize(
      "supervisor_warning",
      { message: "Use the fallback route before retrying." },
      "Warning recorded in parent-visible run status.",
    );
    expect(guidance?.issues?.[0]?.message).not.toContain("fallback route");
    expect(
      summarize("supervisor_progress", { message: "\u001b[31mchecking\nfiles" })?.subject,
    ).not.toContain("\u001b");
  });

  it("does not discard additional content even beside a recognized acknowledgement", () => {
    expect(
      summarize("supervisor_progress", { message: "working" }, [
        "Progress delivered to the parent projection.",
        "Recovery evidence",
      ]),
    ).toBeUndefined();
  });
});
