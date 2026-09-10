import { expect, it } from "vitest";
import { McpResultNavigation, resultPage } from "../../src/ui/result-view.ts";

const page = (offset: number, next: number | null, text: string) =>
  resultPage({
    action: "result.read",
    outcome: "completed",
    isError: false,
    notices: [],
    data: {
      offset,
      next,
      total: 40,
      text,
      origin: {
        action: "tools.call",
        outcome: "completed",
        isError: true,
        outputValidation: "failed",
      },
    },
  });
it("successful retrieval preserves originating failure and uses the returned Unicode-safe next offset", () => {
  const first = page(0, 7, "a🙂text")!;
  expect(first.next).toBe(7);
  expect(first.lines[0]).toContain("original operation failed");
  expect(first.lines[0]).toContain("validation failed");
  const navigation = new McpResultNavigation();
  navigation.accept(first, "current");
  expect(navigation.nextOffset).toBe(7);
  navigation.accept(page(7, 20, "another page")!, "next");
  expect(navigation.previousOffset).toBe(0);
  navigation.accept(first, "previous");
  expect(navigation.previousOffset).toBeUndefined();
});
it("evicted or revoked data is withdrawn rather than revived from page cache", () => {
  const navigation = new McpResultNavigation();
  navigation.accept(page(0, 7, "sensitive retained text")!, "current");
  navigation.invalidate();
  expect(navigation.page).toBeUndefined();
  expect(navigation.nextOffset).toBeUndefined();
  navigation.unavailable();
  expect(navigation.previousOffset).toBeUndefined();
});
it("malformed read envelopes and terminal controls cannot fabricate usable paging", () => {
  expect(page(5, 5, "bad")).toBeUndefined();
  expect(
    resultPage({
      action: "result.read",
      outcome: "completed",
      isError: true,
      notices: [],
      data: {},
    }),
  ).toBeUndefined();
  expect(page(0, null, "hello\u001b[2J\u001b]52;c;secret\u0007")?.lines.join("\n")).not.toContain(
    "\u001b",
  );
});
