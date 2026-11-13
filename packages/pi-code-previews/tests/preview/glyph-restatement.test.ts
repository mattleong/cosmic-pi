import { expect, test } from "vitest";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { layoutExpandedCompactHeading, type CompactRowInput } from "../../src/preview/compact-row";
import type { CompactPhase, CompactSummary } from "../../src/tools/compact-summary";
import { plainTheme as theme, stripAnsi } from "../support/render";

const row = (phase: CompactPhase, summary: Omit<CompactSummary, "subject">): CompactRowInput => ({
  name: "agent_await",
  phase,
  summary: { subject: "auth-review", ...summary },
});

const collapsed = (input: CompactRowInput) =>
  stripAnsi(
    Arr.join(renderCompactToolCall({ ...input, expandLabel: undefined }, theme, 100), "\n"),
  );

const expanded = (input: CompactRowInput) =>
  stripAnsi(
    Arr.join(layoutExpandedCompactHeading({ ...input, expanded: true }, theme, 100).rows, "\n"),
  );

const shows = (input: CompactRowInput, fact: string) => {
  const both = [collapsed(input), expanded(input)];
  expect(both[0]).toContain("auth-review");
  return Arr.map(both, (text) => Fn.pipe(text, Str.includes(`· ${fact}`)));
};

test("a heading leaves out a fact that only restates its status glyph", () => {
  const restated: ReadonlyArray<readonly [CompactRowInput, string]> = [
    [row("running", { counters: ["running"] }), "running"],
    [row("pending", { counters: ["Starting"] }), "Starting"],
    [row("settled", { outcome: "success", counters: ["started"] }), "started"],
    [row("settled", { outcome: "success", metadata: ["finished"] }), "finished"],
    [row("settled", { outcome: "error", counters: [" Failed "] }), "Failed"],
    [row("settled", { outcome: "cancelled", counters: ["stopped"] }), "stopped"],
    [row("settled", { outcome: "paused", counters: ["paused"] }), "paused"],
    [row("settled", { outcome: "queued", counters: ["queued"] }), "queued"],
    [row("running", { queued: true, counters: ["queued"] }), "queued"],
  ];
  for (const [input, fact] of restated) expect(shows(input, fact)).toEqual([false, false]);
});

test("a heading keeps counts, other facts, and words a shared or neutral glyph doesn't say", () => {
  const kept: ReadonlyArray<readonly [CompactRowInput, string]> = [
    [row("running", { counters: ["1 of 2 finished"] }), "1 of 2 finished"],
    [row("settled", { outcome: "error", counters: ["2 failed"] }), "2 failed"],
    [row("settled", { outcome: "cancelled", counters: ["timed out"] }), "timed out"],
    [row("running", { waiting: true, counters: ["needs your input"] }), "needs your input"],
    [row("running", { waiting: true, counters: ["waiting for reply"] }), "waiting for reply"],
    // Beside a neutral `•` the word describes something other than the call.
    [row("settled", { outcome: "returned", counters: ["running"] }), "running"],
    // Beside a message glyph `queued` means held for delivery.
    [row("settled", { outcome: "success", messageIcon: "sent", counters: ["queued"] }), "queued"],
  ];
  for (const [input, fact] of kept) expect(shows(input, fact)).toEqual([true, true]);
});

test("a heading keeps facts that describe its subject's state, not the call's outcome", () => {
  // A read that succeeded reports an agent that finished, or one still running.
  const read = (counter: string, outcome: CompactSummary["outcome"] = "success") =>
    row("settled", { outcome, subjectState: true, counters: [counter], metadata: ["report"] });
  expect(shows(read("finished"), "finished")).toEqual([true, true]);
  expect(shows(read("stopped", "cancelled"), "stopped")).toEqual([true, true]);
  expect(shows(row("settled", { outcome: "success", counters: ["finished"] }), "finished")).toEqual(
    [false, false],
  );
});

test("a restating fact gives way to the heading's other facts", () => {
  const input = row("settled", {
    outcome: "success",
    metadata: ["finished", "ready to apply"],
  });
  expect(shows(input, "finished")).toEqual([false, false]);
  expect(shows(input, "ready to apply")).toEqual([true, true]);
  // A combined counter keeps its other facts.
  const combined = row("settled", {
    outcome: "success",
    counters: ["finished · ready to apply", "finished"],
  });
  expect(shows(combined, "finished")).toEqual([false, false]);
  expect(shows(combined, "ready to apply")).toEqual([true, true]);
});

test("a heading reduces a phrase that measures its glyph's state to the duration", () => {
  const measured: ReadonlyArray<readonly [CompactRowInput, string, string]> = [
    [
      row("settled", { outcome: "success", metadata: ["finished in 1m 33s"] }),
      "finished",
      "1m 33s",
    ],
    [row("settled", { outcome: "error", metadata: ["failed after 28s"] }), "failed", "28s"],
    [row("settled", { outcome: "cancelled", metadata: ["stopped after 2.1s"] }), "stopped", "2.1s"],
  ];
  for (const [input, word, duration] of measured) {
    expect(shows(input, word)).toEqual([false, false]);
    expect(shows(input, duration)).toEqual([true, true]);
  }
  // A phrase another glyph shows, one about the subject, or one that isn't a duration stays whole.
  const kept: ReadonlyArray<readonly [CompactRowInput, string]> = [
    [row("settled", { outcome: "error", metadata: ["stopped after 1m"] }), "stopped after 1m"],
    [
      row("settled", { outcome: "success", subjectState: true, metadata: ["finished in 9s"] }),
      "finished in 9s",
    ],
    [row("settled", { outcome: "error", metadata: ["failed in staging"] }), "failed in staging"],
  ];
  for (const [input, fact] of kept) expect(shows(input, fact)).toEqual([true, true]);
});
