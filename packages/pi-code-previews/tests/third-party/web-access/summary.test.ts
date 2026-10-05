import assert from "node:assert/strict";
import { it } from "vitest";
import { issueMessageStyleProblems, renderContextFixture } from "../../../testing";
import { webAccessSummary } from "../../../src/third-party/web-access/summary";
import type { WebAccessTool } from "../../../src/third-party/web-access/identity";

function summarize<Details>(
  name: WebAccessTool,
  details: Details,
  phase: "running" | "settled" = "settled",
) {
  const args = { query: "example", claim: "A claim", url: "https://example.test" };
  return webAccessSummary(name)({
    phase,
    args,
    result: { content: [{ type: "text", text: "Complete output and recovery" }], details },
    context: renderContextFixture({ args, isPartial: phase === "running" }),
  });
}

it("counts delivered evidence without asserting operation success or claim truth", () => {
  for (const [name, details] of [
    ["web_search", { queryCount: 2, successfulQueries: 2, totalResults: 4 }],
    ["fetch_content", { urlCount: 2, successful: 2 }],
    ["source_check", { sourceCount: 1, passageCount: 2, searchCount: 1 }],
    ["get_search_content", { contentLength: 500, returnedChars: 100, nextOffset: 100 }],
    ["web_enable", { enabled: ["web_search", "fetch_content"] }],
  ] as const) {
    const summary = summarize(name, details);
    assert.equal(summary?.outcome, "returned");
    assert.ok(summary?.counters?.length);
  }
});

it("keeps partial failures, domain errors, and cancellation distinct", () => {
  const mixed = summarize("web_search", { queryCount: 3, successfulQueries: 1, totalResults: 2 });
  assert.equal(mixed?.outcome, "returned");
  assert.equal(mixed?.issues?.[0]?.severity, "warning");
  const failure = summarize("fetch_content", {
    error: "Error: upstream unavailable\nOriginal diagnostics",
  });
  assert.equal(failure?.outcome, "error");
  assert.match(failure?.issues?.[0]?.detail ?? "", /Original diagnostics/);
  assert.equal(
    summarize("web_search", { error: "cancelled", cancelled: true })?.outcome,
    "cancelled",
  );
  const research = summarize("source_check", {
    sourceCount: 1,
    passageCount: 1,
    searchCount: 2,
    artifact: { errors: [{ error: "Search failed" }], sources: [{ fetch_error: "Fetch failed" }] },
  });
  assert.equal(research?.outcome, "returned");
  assert.equal(research?.issues?.[0]?.severity, "warning");
  for (const summary of [mixed, failure, research])
    for (const issue of summary?.issues ?? [])
      assert.deepEqual(issueMessageStyleProblems(issue.message), []);
});

it("treats shortened output with a recovery reference as informational, not proof of availability", () => {
  const base = { urlCount: 1, successful: 1, truncated: true };
  const recoverable = summarize("fetch_content", { ...base, responseId: "private-reference" });
  assert.equal(recoverable?.issues?.[0]?.severity, "info");
  assert.equal(recoverable?.issues?.[0]?.message.includes("private-reference"), false);
  assert.match(recoverable?.issues?.[0]?.detail ?? "", /private-reference/);
  assert.equal(summarize("fetch_content", base)?.issues?.[0]?.severity, "warning");
});

it("keeps normal stored-content pagination informational when only the request carries its reference", () => {
  const args = { responseId: "request-reference", offset: 0 };
  const details = { contentLength: 500, returnedChars: 100, nextOffset: 100, truncated: true };
  const summary = webAccessSummary("get_search_content")({
    args,
    phase: "settled",
    result: { content: [{ type: "text", text: "Page and continuation instructions" }], details },
    context: renderContextFixture({ args, isPartial: false }),
  });
  assert.equal(summary?.issues?.[0]?.severity, "info");
  assert.match(summary?.issues?.[0]?.detail ?? "", /request-reference/);
});

it("declines malformed, contradictory, excessive, and unknown settled evidence", () => {
  for (const details of [
    undefined,
    null,
    [],
    1,
    { version: "future" },
    { phase: "search", progress: 0.5 },
    { queryCount: -1, successfulQueries: 0, totalResults: 1 },
    { queryCount: 1, successfulQueries: 2, totalResults: 1 },
    { queryCount: 1, successfulQueries: 1, totalResults: Infinity },
    { queryCount: "1", successfulQueries: 1, totalResults: 1 },
    { error: "x".repeat(8193) },
  ])
    assert.equal(summarize("web_search", details), undefined);
  assert.equal(summarize("fetch_content", { urlCount: 1, successful: 2 }), undefined);
  assert.equal(
    summarize("get_search_content", { contentLength: 10, offset: 9, returnedChars: 2 }),
    undefined,
  );
  assert.equal(
    summarize("source_check", {
      sourceCount: 1,
      passageCount: 1,
      searchCount: 1,
      artifact: { errors: Array.from({ length: 257 }, () => ({ error: "fail" })) },
    }),
    undefined,
  );
});

it("does not invoke getters in projected provider fields or array slots", () => {
  let reads = 0;
  const details = Object.defineProperty({}, "error", {
    get() {
      reads++;
      throw new Error("getter");
    },
  });
  assert.equal(summarize("web_search", details), undefined);
  const enabled = Object.defineProperty(["web_search"], "0", {
    get() {
      reads++;
      return "web_search";
    },
  });
  assert.equal(summarize("web_enable", { enabled }), undefined);
  assert.equal(reads, 0);
});

it("live progress never manufactures a completed outcome", () => {
  const summary = summarize("web_search", { phase: "search", progress: 0.5 }, "running");
  assert.equal(summary?.outcome, undefined);
  assert.equal(summary?.counters, undefined);
});
