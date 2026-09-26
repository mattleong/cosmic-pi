import { expect, it } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
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
    nested: card.presentation.issues.some((issue) => issue.code === "boundary-failure"),
    summary: summary?.issues?.some((issue) => issue.code === "boundary-failure") ?? false,
  };
};

it("preserves all bounded unclassified notices and declines incomplete notice evidence", () => {
  const notices = Array.from({ length: 32 }, (_, index) => `Operator instruction ${index}`);
  const card = decodeMcpCardDetails(envelope({ kind: "stale" }, notices));
  const instructions = card.boundary!.issues.find((issue) => issue.code === "unclassified-notices");
  expect(instructions?.severity).toBe("warning");
  for (const notice of notices) expect(instructions?.detail).toContain(notice);
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
  const oversized = Array.from({ length: 5 }, (_, index) => `${index}${"n".repeat(499)}`);
  expect(views(envelope({ kind: "stale" }, oversized))).toEqual(declined);
  // A notice that sanitizes to empty is dropped rather than shown as a blank warning.
  const controls = decodeMcpCardDetails(envelope({ kind: "stale" }, ["\u001b[31m\u0007"]));
  expect(controls.boundary?.issues).toEqual(controls.presentation.issues);
  expect(controls.presentation.issues.map((issue) => issue.code)).toEqual(["boundary-failure"]);
});

it("classifies uncertainty, cancellation, and blockers without remote messages", () => {
  const view = <Data>(data: Data, outcome = "not-sent") =>
    decodeMcpCardDetails({
      details: { action: "tools.call", outcome, isError: true, data, notices: [] },
    });
  const cancelled = view({ kind: "cancelled", message: "PRIVATE REMOTE MESSAGE" });
  expect(cancelled.boundary?.outcome).toBe("cancelled");
  expect(cancelled.presentation.issues[0]?.severity).toBe("warning");
  expect(JSON.stringify(cancelled.presentation.issues)).not.toContain("PRIVATE");
  const uncertain = view({ kind: "cleanup" }, "unknown");
  expect(uncertain.boundary?.outcome).toBe("uncertain");
  expect(uncertain.presentation.issues.map((issue) => [issue.code, issue.severity])).toEqual([
    ["boundary-failure", "error"],
    ["cleanup-unconfirmed", "warning"],
  ]);
  const blocked = view({ kind: "auth-required", reason: "oauth-mutation-unresolved" });
  expect(blocked.presentation.issues.map((issue) => issue.code)).toContain(
    "credential-unconfirmed",
  );
});

it("marks an unreadable failure reason incomplete without adding an issue", () => {
  const data = Object.defineProperty({ kind: "stale" }, "reason", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  const readable = decodeMcpCardDetails(envelope({ kind: "stale" }, [], "tools.call")).presentation;
  const unreadable = decodeMcpCardDetails(envelope(data, [], "tools.call")).presentation;
  expect([readable.incomplete, unreadable.incomplete]).toEqual([false, true]);
  expect(unreadable.issues).toEqual(readable.issues);
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
  const rendered = renderMcpResult(result, { expanded: true, isPartial: false }, plainTheme)
    .render(300)
    .join("\n");
  expect(rendered).toContain(recovery);
});
