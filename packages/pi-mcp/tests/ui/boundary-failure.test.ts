import { expect, it } from "vitest";
import { mcpBoundaryFailure } from "../../src/ui/boundary-failure.ts";
import { decodeMcpCardDetails } from "../../src/ui/tool-render-details.ts";
import { renderMcpResult } from "../../src/ui/tool-renderer.ts";

const envelope = <Data, Notices>(data: Data, notices: Notices) => ({
  details: {
    action: "result.read",
    outcome: "not-sent",
    isError: true,
    data,
    notices,
  },
});

it("preserves all bounded unclassified notices and declines incomplete notice evidence", () => {
  const notices = Array.from({ length: 32 }, (_, index) => `Operator instruction ${index}`);
  const view = mcpBoundaryFailure(decodeMcpCardDetails(envelope({ kind: "stale" }, notices)))!;
  const instructions = view.issues.entries.find((issue) => issue.code === "unclassified-notices")!;
  for (const notice of notices) expect(instructions.cause).toContain(notice);
  for (const malformed of [[...notices, "extra"], ["x".repeat(513)], [42], undefined]) {
    expect(
      mcpBoundaryFailure(decodeMcpCardDetails(envelope({ kind: "stale" }, malformed))),
    ).toBeUndefined();
  }
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
  expect(mcpBoundaryFailure(card)).toBeUndefined();
  const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
  const rendered = renderMcpResult(result, { expanded: true, isPartial: false }, theme)
    .render(300)
    .join("\n");
  expect(rendered).toContain(recovery);
});
