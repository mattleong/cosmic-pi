import { expect, it } from "vitest";
import { makeSseBudget } from "../../../src/boundary/mcp-protocol/shared/sse-budget.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
it("bounds buffered SSE events rather than total stream lifetime", () => {
  const accept = makeSseBudget(2_048);
  const event = bytes(`data: ${"x".repeat(1_024)}\n\n`);
  for (let i = 0; i < 10_000; i++) expect(accept(event)).toBe(true);
});
it.each(["\n", "\r", "\r\n"])("handles %j framing across arbitrary chunk boundaries", (newline) => {
  const accept = makeSseBudget(32);
  const event = bytes(`data: abc${newline}${newline}`.repeat(100));
  for (const byte of event) expect(accept(Uint8Array.of(byte))).toBe(true);
});
it("does not accumulate discarded keepalive comments without blank event separators", () => {
  const accept = makeSseBudget(32);
  for (let i = 0; i < 10_000; i++) expect(accept(bytes(": keepalive\n"))).toBe(true);
});
it("rejects an incomplete line before it can grow beyond the cap", () => {
  const accept = makeSseBudget(16);
  expect(accept(bytes("data: "))).toBe(true);
  expect(accept(bytes("x".repeat(11)))).toBe(false);
});
it("rejects an incomplete multi-line event before SDK concatenation", () => {
  const accept = makeSseBudget(32);
  expect(accept(bytes("data: 123456789\n"))).toBe(true);
  expect(accept(bytes("data: 123456789\n"))).toBe(true);
  expect(accept(bytes("data: third\n"))).toBe(false);
});
