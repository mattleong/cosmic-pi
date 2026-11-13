import { beforeEach, describe, expect, it } from "vitest";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { stripAnsi } from "pi-cosmic-core";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  expansionTag,
} from "../../testing";
import { withCodePreviewMessageShell } from "../../src/preview/message-shell";
import { headingValue } from "../../index";
import type { CompactChild, CompactSummary } from "../../src/tools/compact-summary";
import { codemodeRenderers, nativeCall, scriptResult } from "../support/native-codemode";
import { demoShellTool, drawMessage, textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
    toolCallBackground: "off",
    syntaxHighlighting: false,
  }),
);

const plain = (rows: readonly string[]) =>
  Arr.filter(Str.split(stripAnsi(Arr.join(rows, "\n")), "\n"), (row) => Str.trim(row) !== "");

const child = (
  subject: string,
  status: CompactChild["status"],
  failure?: string,
): CompactChild => ({
  label: "probe",
  subject,
  status,
  ...(failure !== undefined && {
    issues: [{ severity: "error", code: "probe-failed", message: failure }],
  }),
});

/** A tool whose summary nests calls and whose expansion shows every one of them. */
const nested = (summary: (phase: string) => CompactSummary) =>
  demoShellTool(summary, {
    expandedResult: () =>
      new Text(
        Arr.join(
          Arr.map(summary("settled").children?.entries ?? [], (entry) => entry.subject ?? ""),
          "\n",
        ),
        0,
        0,
      ),
  });

const tree = {
  entries: [child("FIRST_CALL", "returned"), child("SECOND_CALL", "error", "SECOND_FAILED")],
  total: 2,
};

describe("a collapsed compact row", () => {
  it("is its heading row and one line per problem, with its output behind the tag", () => {
    const harness = createToolPresentationHarness(
      nested((phase) => ({
        subject: "a.ts",
        issues: [
          { severity: "warning", code: "demo-warning", message: "WARNING_LINE" },
          { severity: "info", code: "demo-info", message: "INFO_LINE" },
        ],
        ...(phase === "settled" && { outcome: "warning" }),
      })),
    );
    harness.call({ path: "a.ts" });
    harness.result(textResult(Arr.join(Arr.replicate("OUTPUT_LINE", 30), "\n")));
    const rows = plain(harness.render());
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("WARNING_LINE");
    expect(Arr.join(rows, "\n")).not.toContain("OUTPUT_LINE");
    expect(Arr.join(rows, "\n")).not.toContain("INFO_LINE");
    expect(expansionTag(harness.render()[0] ?? "")).toBeDefined();
    harness.call({ path: "a.ts" }, { expanded: true });
    harness.result(textResult(Arr.join(Arr.replicate("OUTPUT_LINE", 30), "\n")), {
      expanded: true,
    });
    const expanded = Arr.join(plain(harness.render()), "\n");
    expect(expanded).toContain("INFO_LINE");
  });

  it("shows its call tree only while running, then lifts a hidden failure as a problem line", () => {
    const harness = createToolPresentationHarness(
      // A declaration that expansion adds nothing can't hide the settled tree's expansion.
      nested((phase) => ({
        subject: "",
        children: tree,
        expandLabel: false,
        ...(phase === "settled" && { outcome: "warning" }),
      })),
    );
    harness.call({ path: "a.ts" }, { executionStarted: true, isPartial: true });
    harness.result(textResult("partial"), { isPartial: true });
    const running = Arr.join(plain(harness.render()), "\n");
    expect(running).toContain("FIRST_CALL");
    expect(running).toContain("SECOND_CALL");

    harness.result(textResult("done"));
    const settled = plain(harness.render());
    expect(settled).toHaveLength(2);
    expect(Arr.join(settled, "\n")).not.toContain("FIRST_CALL");
    // The failed call surfaces beneath the row, naming the call and its cause.
    expect(settled[1]).toContain("SECOND_CALL");
    expect(settled[1]).toContain("SECOND_FAILED");
    expect(expansionTag(harness.render()[0] ?? "")).toBeDefined();

    harness.result(textResult("done"), { expanded: true });
    const expanded = Arr.join(plain(harness.render()), "\n");
    expect(expanded).toContain("FIRST_CALL");
    expect(expanded).toContain("SECOND_CALL");
  });

  it("counts the running children it leaves out by the producer's noun", () => {
    const entries = Arr.makeBy(9, (index) => child(`RUN_${index}`, "running"));
    const harness = createToolPresentationHarness(
      nested(() => ({ subject: "", children: { entries, total: entries.length, noun: "NOUN" } })),
    );
    harness.call({ path: "a.ts" }, { executionStarted: true, isPartial: true });
    harness.result(textResult("partial"), { isPartial: true });
    const running = Arr.join(plain(harness.render()), "\n");
    expect(
      Arr.filter(entries, (entry) => Fn.pipe(running, Str.includes(entry.subject ?? ""))),
    ).not.toHaveLength(entries.length);
    expect(running).toMatch(/more NOUNs/u);
  });

  it("names each hidden failure once, however many calls failed", () => {
    const failures = Arr.map(Arr.range(1, 8), (index) =>
      child(`CALL_${index}`, "error", `FAILED_${index}`),
    );
    const harness = createToolPresentationHarness(
      nested((phase) => ({
        subject: "",
        children: { entries: failures, total: failures.length },
        ...(phase === "settled" && { outcome: "error" }),
      })),
    );
    harness.call({ path: "a.ts" });
    harness.result(textResult("done"));
    const rows = plain(harness.render(120));
    // Every failure is accounted for: named, or counted on one closing line.
    const named = Arr.filter(rows, (row) => Fn.pipe(row, Str.includes("FAILED_"))).length;
    expect(named).toBeGreaterThan(0);
    expect(named).toBeLessThan(failures.length);
    expect(Arr.join(rows, "\n")).toContain(`${failures.length - named} more`);
  });
});

describe("a settled codemode row", () => {
  const args = { code: "await tools.bash({ command: 'one' })" };
  const result = scriptResult(
    "completed",
    {
      calls: [
        nativeCall({ id: "1", name: "bash", args: '{"command":"echo FIRST_CALL"}' }),
        nativeCall({
          id: "2",
          name: "bash",
          args: '{"command":"echo SECOND_CALL"}',
          status: "error",
          error: "SECOND_FAILED",
        }),
      ],
    },
    { type: "text", text: "SCRIPT_OUTPUT" },
  );

  it("is one row with its failed call lifted, counted in its heading, and offers its calls", () => {
    const harness = createToolPresentationHarness(codemodeRenderers());
    harness.call(args, { executionStarted: true });
    harness.result(result);
    const rows = plain(harness.render(120));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("1 failed");
    expect(rows[1]).toContain("SECOND_FAILED");
    expect(Arr.join(rows, "\n")).not.toContain("FIRST_CALL");
    expect(expansionTag(harness.render(120)[0] ?? "")).toBeTruthy();

    harness.call(args, { executionStarted: true, expanded: true });
    harness.result(result, { expanded: true });
    const expanded = Arr.join(plain(harness.render(120)), "\n");
    for (const marker of ["FIRST_CALL", "SECOND_CALL", "SECOND_FAILED", "SCRIPT_OUTPUT"])
      expect(expanded).toContain(marker);
  });
});

const draw = (render: MessageRenderer, expanded: boolean) => plain(drawMessage(render, expanded));

describe("a collapsed message", () => {
  const report = withCodePreviewMessageShell(() => ({
    name: "agent_report",
    summary: {
      subject: "Fan out",
      outcome: "success",
      issues: [{ severity: "warning", code: "demo", message: "REPORT_WARNING" }],
    },
    bodyLabel: "Report",
    collapsed: () => new Text("REPORT_WORDS", 0, 0),
    expanded: () => new Text("REPORT_WORDS\nREPORT_END", 0, 0),
  }));

  it("draws no body in compact style, only its heading and problems, and still offers the body", () => {
    const rows = draw(report, false);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("REPORT_WARNING");
    expect(Arr.join(rows, "\n")).not.toContain("REPORT_WORDS");
    expect(expansionTag(rows[0] ?? "")).toBeTruthy();
    const expanded = Arr.join(draw(report, true), "\n");
    expect(expanded).toContain("REPORT_WORDS");
    expect(expanded).toContain("REPORT_END");
  });

  it("offers nothing in compact style when it has no body", () => {
    const bare = withCodePreviewMessageShell(() => ({
      name: "agent_report",
      summary: { subject: "Fan out", outcome: "success" },
    }));
    const [row = ""] = draw(bare, false);
    expect(expansionTag(row)).toBeUndefined();
  });
});

describe("a heading value", () => {
  it("is one short line, never prose or several lines", () => {
    expect(headingValue("  red ")).toBe("red");
    expect(headingValue("Staging")).toBe("Staging");
    expect(headingValue("first\nsecond")).toBeUndefined();
    expect(headingValue("")).toBeUndefined();
    expect(headingValue("a · b")).toBeUndefined();
    expect(headingValue("Ship the release to staging first, then production")).toBeUndefined();
  });
});
