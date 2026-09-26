import { expect, it } from "vitest";
import { projectMcpCompactSummary } from "../../src/ui/compact-summary.ts";
import { decodeMcpCardDetails } from "../../src/ui/tool-render-details.ts";
import { renderMcpResult } from "../../src/ui/tool-renderer.ts";

const envelope = <Data, Notices>(data: Data, notices: Notices, action = "result.read") => ({
  details: { action, outcome: "not-sent", isError: true, data, notices },
});
const declined = { card: undefined, nested: false, summary: false };
const views = <Details>(result: { readonly details: Details }) => {
  const card = decodeMcpCardDetails(result);
  const summary = projectMcpCompactSummary({
    phase: "settled",
    args: { action: "result.read" },
    result,
    isError: true,
  });
  return {
    card: card.boundary,
    nested: card.presentation.issues.entries.some((issue) => issue.code === "boundary-failure"),
    summary: summary?.issues?.entries.some((issue) => issue.code === "boundary-failure") ?? false,
  };
};

it("preserves all bounded unclassified notices and declines incomplete notice evidence", () => {
  const notices = Array.from({ length: 32 }, (_, index) => `Operator instruction ${index}`);
  const card = decodeMcpCardDetails(envelope({ kind: "stale" }, notices));
  const instructions = card.boundary!.issues.entries.find(
    (issue) => issue.code === "unclassified-notices",
  )!;
  for (const notice of notices) expect(instructions.cause).toContain(notice);
  expect(card.boundary!.issues).toEqual(card.presentation.issues);
  for (const malformed of [[...notices, "extra"], ["x".repeat(513)], [42], undefined]) {
    expect(views(envelope({ kind: "stale" }, malformed))).toEqual(declined);
  }
});

it("applies one edge rule set to the card, compact summary, and nested projection", () => {
  // Any origin, including a malformed null, declines the view everywhere.
  for (const origin of [null, { action: "tools.call", outcome: "completed", isError: false }])
    expect(views(envelope({ kind: "stale", origin }, []))).toEqual(declined);
  // Oversized notice evidence declines everywhere, including the expanded card.
  const oversized = Array.from({ length: 5 }, () => "n".repeat(500));
  expect(views(envelope({ kind: "stale" }, oversized))).toEqual(declined);
  // A notice that sanitizes to empty is dropped rather than shown as a blank warning.
  const controls = decodeMcpCardDetails(envelope({ kind: "stale" }, ["\u001b[31m\u0007"]));
  expect(controls.boundary?.issues).toEqual(controls.presentation.issues);
  expect(controls.presentation.issues.entries.map((issue) => issue.code)).toEqual([
    "boundary-failure",
  ]);
});

it("marks an unreadable failure reason incomplete without adding a notice", () => {
  const data = Object.defineProperty({ kind: "stale" }, "reason", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  const readable = decodeMcpCardDetails(envelope({ kind: "stale" }, [], "tools.call")).presentation;
  const unreadable = decodeMcpCardDetails(envelope(data, [], "tools.call")).presentation;
  expect([readable.incomplete, unreadable.incomplete]).toEqual([false, true]);
  expect(unreadable.notices).toEqual(readable.notices);
});

it("retains original recovery when bounded raw preview cuts could hide the message", () => {
  const recovery = "Operator must inspect affected state before choosing another action.";
  const data = {
    kind: "stale",
    ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, index])),
    message: recovery,
  };
  const result = envelope(data, []);
  const card = decodeMcpCardDetails(result);
  expect(card.displayCuts.length).toBeGreaterThan(0);
  expect(card.preview).not.toContain(recovery);
  expect(card.boundary).toBeUndefined();
  const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderMcpResult(result, { expanded: true, isPartial: false }, theme)
    .render(300)
    .join("\n");
  expect(rendered).toContain(recovery);
});
