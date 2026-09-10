import { expect, it } from "vitest";
import { McpResultNavigation, resultPage } from "../../src/ui/result-view.ts";
import type { McpGatewayReply } from "../../src/tools/model.ts";

const retained = (
  text: string,
  patch: { format?: string; offset?: number; next?: number | null; total?: number } = {},
): McpGatewayReply => ({
  action: "result.read",
  outcome: "completed",
  isError: false,
  notices: [],
  data: {
    format: "json",
    offset: 0,
    next: null,
    total: text.length,
    text,
    origin: { action: "tools.call", outcome: "completed", isError: false },
    ...patch,
  },
});

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

it("decodes only complete authorized JSON pages and keeps every partial page raw", () => {
  const text = JSON.stringify({
    content: [{ type: "text", text: "first\n  second" }],
    metadata: "raw-only",
  });
  const complete = resultPage(retained(text))!;
  expect(complete.readableLines?.join("\n")).toContain("first\n  second");
  expect(complete.lines.join("\n")).toContain("raw-only");
  expect(complete.readableLines?.join("\n")).not.toContain("raw-only");
  for (const patch of [
    { format: "text" },
    { offset: 1 },
    { next: text.length, total: text.length + 1 },
    { offset: 3, next: text.length + 3, total: text.length + 4 },
    { offset: 3, next: null, total: text.length + 3 },
    { total: text.length - 1 },
    { total: text.length + 1 },
  ]) {
    const partial = resultPage(retained(text, patch))!;
    expect(partial.readableLines).toBeUndefined();
    expect(partial.lines.at(-1)).toBe(text);
  }
  expect(
    resultPage({
      ...retained(text),
      data: {
        offset: 0,
        next: null,
        total: text.length,
        text,
        origin: { action: "tools.call", outcome: "completed", isError: false },
      },
    })?.readableLines,
  ).toBeUndefined();
  expect(resultPage({ ...retained(text), isError: true })).toBeUndefined();
  expect(resultPage({ ...retained(text), outcome: "unknown" })).toBeUndefined();
  expect(resultPage({ ...retained(text), action: "tools.call" })).toBeUndefined();
  expect(resultPage(retained('{"content":'))?.readableLines).toBeUndefined();
});

it("uses original length for completeness even when control removal changes display length", () => {
  const text = JSON.stringify({ content: [{ type: "text", text: "safe\x1b[2J\n  preserved" }] });
  const loaded = resultPage(retained(text))!;
  expect(loaded.readableLines?.join("\n")).toContain("safe\n  preserved");
  expect(loaded.total).toBe(text.length);
  expect(resultPage(retained(text, { total: text.length - 1 }))?.readableLines).toBeUndefined();
});

it("retained raw exposes page-sized strings, collections, and metadata beyond card limits", () => {
  const long = "x".repeat(4000) + "tail-not-in-card";
  const value = {
    content: [{ type: "text", text: long }],
    metadata: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`field-${index}`, index]),
    ),
    rows: Array.from({ length: 40 }, (_, index) => `row-${index}`),
    oauthState: "PRIVATE-STATE",
  };
  const text = JSON.stringify(value);
  expect(text.length).toBeLessThan(8192);
  const reply = retained(text);
  const before = JSON.stringify(reply);
  const loaded = resultPage(reply)!;
  expect(loaded.lines.join("\n")).toContain(long);
  expect(loaded.lines.join("\n")).toContain("field-39");
  expect(loaded.lines.join("\n")).toContain("row-39");
  expect(loaded.lines.join("\n")).not.toContain("PRIVATE");
  expect(loaded.readableLines?.join("\n")).toContain(long);
  expect(JSON.stringify(reply)).toBe(before);
});

it("contains deeply nested complete JSON without an unbounded recursive schema walk", () => {
  const text = "[".repeat(10_000) + "0" + "]".repeat(10_000);
  const loaded = resultPage(retained(text))!;
  expect(loaded.lines.join("\n")).toMatch(/display.*omitt/i);
  expect(loaded.readableLines).toBeUndefined();
});

it("diagnostically redacts raw partial pages and sanitizes complete-page fields and notices", () => {
  const partial =
    "safe\n  access\x1b[31m_token=PRIVATE-TOKEN\n\x1b]52;c;PRIVATE-CLIPBOARD\x07visible";
  const loaded = resultPage({
    ...retained(partial, { next: partial.length, total: partial.length + 20 }),
    notices: ["Bearer PRIVATE-NOTICE"],
  })!;
  expect(loaded.lines.join("\n")).not.toContain("PRIVATE");
  expect(loaded.lines.join("\n")).not.toContain("\x1b");
  expect(loaded.lines.join("\n")).toContain("safe\n  access_token=");
  expect(loaded.next).toBe(partial.length);
  const value = {
    content: [{ type: "text", text: "Bearer PRIVATE-TEXT" }],
    authorizationUrl: "PRIVATE-URL",
    callbackUrl: "PRIVATE-CALLBACK",
    state: "ordinary-state",
  };
  const complete = resultPage(retained(JSON.stringify(value)))!;
  expect(complete.lines.join("\n")).not.toContain("PRIVATE");
  expect(complete.readableLines?.join("\n")).not.toContain("PRIVATE");
  expect(complete.lines.join("\n")).toContain("ordinary-state");
});

it("switches locally between texts on the same page authority and withdraws both on invalidation", () => {
  const loaded = resultPage(
    retained(
      JSON.stringify({ content: [{ type: "text", text: "readable-data" }], extra: "raw-data" }),
    ),
  )!;
  const navigation = new McpResultNavigation();
  navigation.accept(loaded, "current");
  expect(navigation.mode).toBe("readable");
  expect(navigation.lines).toBe(loaded.readableLines);
  expect(navigation.toggleMode()).toBe(true);
  expect(navigation.lines).toBe(loaded.lines);
  expect(navigation.page).toBe(loaded);
  navigation.invalidate();
  expect(navigation.lines).toBeUndefined();
  expect(navigation.page).toBeUndefined();
  expect(navigation.hasReadable).toBe(false);
  expect(navigation.toggleMode()).toBe(false);
  navigation.accept(loaded, "current");
  expect(navigation.mode).toBe("raw");
  navigation.unavailable();
  expect(navigation.lines).toBeUndefined();
});
