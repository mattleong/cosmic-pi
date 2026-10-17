import assert from "node:assert/strict";
import { it } from "vitest";
import { issueMessageStyleProblems, renderContextFixture } from "../../../testing";
import { webAccessSummary } from "../../../src/third-party/web-access/summary";
import type { WebAccessTool } from "../../../src/third-party/web-access/identity";
import type { HostValue } from "../../../src/shared/untrusted-value";

function summarize(
  name: WebAccessTool,
  details: HostValue | undefined,
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

const firstIssue = (summary: ReturnType<typeof summarize>) => summary?.issues?.[0];

const assertStyledIssues = (summary: ReturnType<typeof summarize>) => {
  for (const issue of summary?.issues ?? [])
    assert.deepEqual(issueMessageStyleProblems(issue.message), []);
};

it("keeps partial failures, domain errors, and cancellation distinct", () => {
  const mixed = summarize("web_search", { queryCount: 3, successfulQueries: 1, totalResults: 2 });
  assert.equal(mixed?.outcome, "returned");
  assert.equal(firstIssue(mixed)?.severity, "warning");
  const failure = summarize("fetch_content", {
    error: "Error: upstream unavailable\nOriginal diagnostics",
  });
  assert.equal(failure?.outcome, "error");
  assert.match(firstIssue(failure)?.detail ?? "", /Original diagnostics/);
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
  assert.equal(firstIssue(research)?.severity, "warning");
  for (const summary of [mixed, failure, research]) assertStyledIssues(summary);
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
