import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { allocateCompactHeader, middleElide } from "../../src/preview/compact-header";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { compactStatus } from "../../src/tools/compact-summary";
import { plainTheme as theme, stripAnsi } from "../support/render";

test("explicit measured timing accompanies counts without overriding disabled timing or inventing replay time", () => {
  for (const timingEnabled of [false, true]) {
    for (const duration of [undefined, "MEASURED"]) {
      const row = renderCompactToolCall(
        {
          name: "code_mode",
          phase: "settled",
          timingEnabled,
          duration,
          elapsedMs: 12,
          summary: {
            subject: "inspect",
            counters: ["3 tools"],
            showTiming: true,
            outcome: "success",
          },
        },
        theme,
        120,
      )[0]!;
      assert.ok(row.includes("3 tools"));
      assert.equal(row.includes("MEASURED"), timingEnabled && duration !== undefined);
    }
  }
  const row = allocateCompactHeader("mode", "target", ["3 tools"], [], 24, " · ", "MEASURED");
  assert.ok(row.includes("3 tools"));
  assert.ok(!row.includes("MEASURED"));
  assert.ok(visibleWidth(row) <= 24);
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

test("card issues keep every character at narrow widths", () => {
  const message = "日本語recover\r\n文字retry";
  for (const severity of ["warning", "error"] as const) {
    for (const width of [2, 3, 6, 7, 12, 40]) {
      const rows = renderCompactToolCall(
        {
          name: "read",
          phase: "settled",
          summary: {
            subject: "file",
            outcome: "warning",
            issues: [{ severity, code: "wide", message }],
          },
        },
        theme,
        width,
      )
        .slice(1)
        .map(stripAnsi);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      const text = rows.join("");
      for (const character of "日本語recover文字retry") assert.ok(text.includes(character));
    }
  }
});

test("collapsed cards show the heading, then attention issues, then the call tree", () => {
  const rows = renderCompactToolCall(
    {
      name: "code_mode",
      phase: "settled",
      summary: {
        subject: "inspect",
        outcome: "warning",
        issues: [
          { severity: "info", code: "hint", message: "HIDDEN_HINT" },
          { severity: "warning", code: "partial", message: "OWN_WARNING", detail: "HIDDEN_DETAIL" },
        ],
        children: {
          total: 2,
          entries: [
            {
              label: "CHILD_READ",
              status: "error",
              issues: [{ severity: "error", code: "missing", message: "CHILD_ERROR" }],
            },
            { label: "CHILD_GREP", status: "success" },
          ],
        },
      },
    },
    theme,
    120,
  ).map(stripAnsi);
  const at = (text: string) => rows.findIndex((row) => row.includes(text));
  assert.equal(at("inspect"), 0);
  assert.equal(at("OWN_WARNING"), 1);
  assert.ok(at("CHILD_READ") > at("OWN_WARNING"));
  assert.equal(at("CHILD_ERROR"), at("CHILD_READ"));
  assert.ok(at("CHILD_GREP") > at("CHILD_READ"));
  assert.equal(rows.length, 4);
  assert.doesNotMatch(rows.join("\n"), /HIDDEN_/u);
  // A failed child does not change its parent's heading status.
  const parent = rows[0]!;
  const alone = renderCompactToolCall(
    {
      name: "code_mode",
      phase: "settled",
      summary: { subject: "inspect", outcome: "warning", issues: [] },
    },
    theme,
    120,
  )[0]!;
  assert.equal(parent, stripAnsi(alone));
});

test("issue text is inert and width bounded", () => {
  for (const width of [1, 4, 16, 40, 100]) {
    const rows = renderCompactToolCall(
      {
        name: "read",
        phase: "settled",
        summary: {
          subject: "file.ts",
          outcome: "error",
          issues: [{ severity: "error", code: "x", message: "日本語/👩‍💻 failed\u001b[2J" }],
        },
      },
      theme,
      width,
    );
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.equal(rows.join("").includes("\u001b[2J"), false);
    if (width >= 40) assert.match(stripAnsi(rows.join("\n")), /failed/u);
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
  assert.equal(compactStatus("pending", { subject: "file.ts", outcome: "error" }), "pending");
  assert.doesNotMatch(rows[0]!, /3s/u);
  assert.equal(
    stripAnsi(rows[0]!),
    stripAnsi(
      renderCompactToolCall(
        { name: "write", phase: "pending", summary: { subject: "file.ts", outcome: "error" } },
        theme,
        100,
      )[0]!,
    ),
  );
});

test("shows the first counter alternative that fits, falling back to shorter ones", () => {
  const counters = ["5 calls · 3 failed", "3 failed"];
  const wide = allocateCompactHeader("code_mode", "Run lint and tests", counters, [], 60);
  assert.match(wide, /5 calls · 3 failed/u);
  const narrow = allocateCompactHeader("code_mode", "Run lint and tests", counters, [], 38);
  assert.match(narrow, /3 failed/u);
  assert.doesNotMatch(narrow, /5 calls/u);
  assert.ok(visibleWidth(narrow) <= 38);
});
