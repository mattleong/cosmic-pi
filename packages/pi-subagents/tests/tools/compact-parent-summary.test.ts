import { renderContextFixture } from "pi-code-previews/testing";
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

describe("child compact acknowledgement policy", () => {
  it("summarizes valid live requests without claiming delivery", () => {
    for (const kind of ["progress", "warning", "question"]) {
      const summary = summarize("contact_parent", { kind, message: "Check the cleanup" });
      expect(summary).toBeDefined();
      expect(summary?.outcome).toBe(kind === "warning" ? "warning" : undefined);
      expect(summary?.subject).toContain("Check the cleanup");
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
      expect(summarize(name, args, receipt, true)).toBeUndefined();
    }
    expect(
      summarize(
        "contact_parent",
        { kind: "question", message: "continue?" },
        "Parent received question.",
      ),
    ).toBeUndefined();
    expect(
      summarize("supervisor_question", { message: "continue?" }, "Parent reply: continue"),
    ).toBeUndefined();
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
    expect(summary?.issues?.[0]?.message).not.toContain("Verify cleanup");
    expect(summary?.issues?.[0]?.detail).toBe(message);
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
