import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { allocateCompactHeader, middleElide } from "../../src/preview/compact-header";
import { renderCompactFailure, renderCompactToolCall } from "../../src/preview/compact-tool-call";
import {
  compactStatus,
  compactSummaryNeedsDetails,
  resolveCompactSummary,
} from "../../src/tools/compact-summary";
import { stripAnsi, testTheme } from "../support/render";

const theme = testTheme();

test("duration is a last-resort detail using numeric elapsed time", () => {
  for (const name of ["read", "bash"]) {
    for (const elapsedMs of [9_999, 10_000]) {
      for (const counters of [[], ["count"]]) {
        const row = renderCompactToolCall(
          {
            name,
            phase: "settled",
            duration: "measured",
            elapsedMs,
            summary: { subject: "target", outcome: "success", counters },
          },
          theme,
          200,
        )[0]!;
        assert.equal(
          row.includes("measured"),
          counters.length === 0 && (name === "bash" || elapsedMs >= 10_000),
        );
      }
    }
  }
  const row = renderCompactToolCall(
    {
      name: "read",
      phase: "settled",
      duration: "10.0s",
      elapsedMs: 9_999,
      summary: { subject: "target", outcome: "success" },
    },
    theme,
    200,
  )[0]!;
  assert.ok(!row.includes("10.0s"));
});

test("compact subjects are single-line, inert and width bounded without losing tool identity", () => {
  for (const width of [1, 4, 16, 40, 100]) {
    const rows = renderCompactToolCall(
      {
        name: "read",
        phase: "running",
        summary: {
          subject: "src/日本語/👩‍💻.ts\nnext\tpart\u001b[2J\r".repeat(20),
          metadata: ["optional"],
        },
        duration: "1.2s",
      },
      theme,
      width,
    );
    assert.equal(rows.length, 1);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.doesNotMatch(stripAnsi(rows.join("")), /[\n\r\t]/u);
    assert.equal(rows.join("").includes("\u001b[2J"), false);
    if (width >= 16) assert.match(rows[0]!, /read/u);
  }
});

test("long subjects retain both ends before duration or detail discovery", () => {
  const rows = renderCompactToolCall(
    {
      name: "bash",
      phase: "running",
      summary: {
        subject: `command ${"long-arguments ".repeat(40)}target.ts`,
        counters: ["+12", "-3"],
      },
      duration: "2.5s",
    },
    theme,
    80,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0]!, /command/u);
  assert.match(rows[0]!, /target\.ts/u);
  assert.match(rows[0]!, /\+12/u);
  assert.doesNotMatch(rows[0]!, /-3/u);
  assert.doesNotMatch(rows[0]!, /2\.5s|expand/u);
  assert.ok(visibleWidth(rows[0]!) <= 80);
});

test("width allocation reserves whole counters without consuming the subject minimum", () => {
  const subject = "abcdefghijklmnopqrstuvwxyz";
  const identity = "edit apply";
  const row = allocateCompactHeader(
    identity,
    subject,
    ["123456789", "+12", "-3"],
    ["metadata"],
    35,
  );
  assert.ok(row.startsWith(identity));
  assert.ok(row.includes(" · 123456789"));
  assert.ok(!row.includes("+12") && !row.includes("-3"));
  const target = row.slice(identity.length + 1).split(" · ")[0]!;
  assert.ok(visibleWidth(target) >= 12);
  assert.ok(target.startsWith("a") && target.endsWith("z"));
  assert.ok(visibleWidth(row) <= 35);
  for (let width = 1; width <= 50; width++) {
    const narrow = allocateCompactHeader(identity, subject, ["+12345"], [], width);
    assert.ok(visibleWidth(narrow) <= width);
    if (narrow.includes("+")) assert.ok(narrow.endsWith("+12345"));
    if (width <= visibleWidth(identity)) assert.ok(!narrow.includes(" · "));
  }
});

test("optional lanes use only slack after a complete subject and admitted counters", () => {
  const base = allocateCompactHeader("read", "file.ts", ["+1"], [], 100);
  const exact = visibleWidth(base);
  assert.equal(
    allocateCompactHeader("read", "file.ts", ["+1"], ["meta", "1s", "hint"], exact),
    base,
  );
  assert.equal(
    allocateCompactHeader("read", "file.ts", ["+1"], ["meta", "1s", "hint"], exact + 7),
    base,
  );
  assert.equal(allocateCompactHeader("read", "file.ts", ["+1"], ["meta", "1s", "hint"], 100), base);
  assert.equal(
    allocateCompactHeader("read", "", ["oversized-counter", "+1", "-2"], [], 22),
    "read",
  );
});

test("fitting counters take priority over chrome with empty or short subjects", () => {
  for (const { subject, width } of [
    { subject: "", width: 35 },
    { subject: "agent-r1-2", width: 40 },
  ]) {
    const counter = subject ? "1/1 finished" : "0/3 finished";
    const row = allocateCompactHeader("subagent_await", subject, [counter], ["1s", "hint"], width);
    assert.ok(row.includes(counter));
    if (subject) assert.ok(row.includes(subject));
    assert.ok(!row.includes("hint"));
    if (subject) assert.ok(!row.includes("1s"));
    assert.ok(visibleWidth(row) <= width);
  }
});

test("middle elision keeps combining, ZWJ and wide graphemes intact", () => {
  for (const edge of ["e\u0301", "👩‍💻", "日"]) {
    const subject = `${edge}${"x".repeat(50)}${edge}`;
    for (const width of [5, 6, 12, 21]) {
      const clipped = middleElide(subject, width);
      assert.ok(clipped.startsWith(edge) && clipped.endsWith(edge));
      assert.ok(clipped.includes("…"));
      assert.ok(visibleWidth(clipped) <= width);
    }
  }
  assert.equal(middleElide("short", Number.MAX_SAFE_INTEGER), "short");
  const row = renderCompactToolCall(
    {
      name: "read",
      phase: "running",
      summary: { action: "scan\nnow", subject: "short", counters: ["+1\tfile", "\u001b[2J"] },
    },
    theme,
    Number.MAX_SAFE_INTEGER,
  )[0]!;
  assert.match(row, /read scan now short/u);
  assert.ok(!row.includes("\u001b[2J"));
  assert.doesNotMatch(stripAnsi(row), /[\n\t]/u);
  assert.ok(visibleWidth(row) < 200);
});

test("notice wrapping retains multiline recovery instructions without subject row expansion", () => {
  const rows = renderCompactToolCall(
    {
      name: "read",
      phase: "settled",
      summary: {
        subject: "file.txt",
        outcome: "warning",
        notices: [
          {
            kind: "recovery",
            text: "Output truncated.\nContinue with offset 2001 to read the remaining data.",
          },
        ],
      },
    },
    theme,
    24,
  );
  const output = rows.join(" ");
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => visibleWidth(row) <= 24));
  assert.match(output, /offset 2001/u);
  assert.match(output, /remaining data/u);
});

test("notice indentation preserves every character at narrow widths", () => {
  const notice = "日本語recover\r\n文字retry";
  for (const kind of ["warning", "error", "recovery"] as const) {
    for (const width of [2, 3, 6, 7, 12, 40]) {
      const rows = renderCompactToolCall(
        {
          name: "read",
          phase: "settled",
          summary: { subject: "file", outcome: "warning", notices: [{ kind, text: notice }] },
        },
        theme,
        width,
      )
        .slice(1)
        .map(stripAnsi);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.equal(rows.join("").replace(/[ ╰─]/gu, ""), notice.replaceAll("\r\n", ""));
    }
  }
});

test("failure text is inert and width bounded without clipping recovery continuations", () => {
  for (const width of [1, 4, 16, 40, 100]) {
    for (const expanded of [false, true]) {
      const rows = renderCompactFailure(
        {
          name: "read",
          phase: "settled",
          summary: {
            subject: "file.ts",
            outcome: "error",
            notices: [{ kind: "recovery", text: "Inspect before retrying." }],
          },
          failure: {
            cause: "日本語/👩‍💻 failed\u001b[2J",
            details: "detail\u001b[2J\nInspect before retrying.",
          },
          expanded,
        },
        theme,
        width,
      );
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.equal(rows.join("").includes("\u001b[2J"), false);
      if (width >= 40)
        assert.equal(rows.join("\n").match(/Inspect before retrying\./gu)?.length, 1);
    }
  }
});

test("owned failure notices deduplicate across line endings without losing narrow wide text", () => {
  const details = "failure\r\nInspect before retrying.\r\nKeep the original file.";
  const rows = renderCompactFailure(
    {
      name: "read",
      phase: "settled",
      expanded: true,
      summary: {
        subject: "file.ts",
        outcome: "error",
        notices: [{ kind: "recovery", text: "Inspect before retrying.\nKeep the original file." }],
      },
      failure: { cause: "cause", details },
    },
    theme,
    100,
  );
  assert.equal(rows.join("\n").match(/Inspect before retrying\./gu)?.length, 1);
  assert.equal(rows.join("\n").match(/Keep the original file\./gu)?.length, 1);
  for (const width of [2, 3, 6]) {
    const narrow = renderCompactFailure(
      {
        name: "read",
        phase: "settled",
        summary: {
          subject: "file.ts",
          outcome: "error",
          notices: [{ kind: "recovery", text: "文字" }],
        },
        failure: { cause: "日本語", details: "日本語" },
      },
      theme,
      width,
    );
    const text = narrow.join("");
    for (const character of "日本語文字") assert.ok(text.includes(character));
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
  }
});

test("pending rows do not display an execution duration or outcome from a premature provider", () => {
  const rows = renderCompactToolCall(
    {
      name: "write",
      phase: "pending",
      summary: { subject: "file.ts", outcome: "success" },
      duration: "3s",
    },
    theme,
    100,
  );
  assert.equal(compactStatus("pending", { subject: "file.ts", outcome: "success" }), "pending");
  assert.doesNotMatch(rows[0]!, /3s/u);
});

test("settlement requires a semantic outcome and Pi errors cannot become success", () => {
  assert.equal(resolveCompactSummary({ subject: "work" }, "settled", false), undefined);
  assert.ok(resolveCompactSummary({ subject: "work" }, "pending", false));
  const overridden = resolveCompactSummary(
    { subject: "work", outcome: "success" },
    "settled",
    true,
  );
  assert.equal(overridden?.outcome, "error");
  assert.equal(compactStatus("running", { subject: "work", outcome: "success" }), "running");
  assert.equal(compactStatus("settled", { subject: "work", outcome: "success" }), "success");
  assert.equal(compactStatus("pending", { subject: "work", outcome: "error" }), "error");
  assert.ok(overridden && compactSummaryNeedsDetails(overridden));
  for (const outcome of ["cancelled", "uncertain", "error"] as const) {
    assert.ok(compactSummaryNeedsDetails({ subject: "work", outcome }));
    assert.ok(compactSummaryNeedsDetails({ subject: "work", outcome, detailsOnExpand: true }));
    assert.equal(
      compactStatus("running", { subject: "work", outcome, detailsOnExpand: true }),
      outcome,
    );
    assert.equal(
      resolveCompactSummary({ subject: "work", outcome }, "settled", true)?.outcome,
      outcome,
    );
  }
  assert.equal(compactSummaryNeedsDetails({ subject: "work", outcome: "warning" }), false);
});
