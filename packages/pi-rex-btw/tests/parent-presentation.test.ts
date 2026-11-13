import { describe, expect, it } from "vitest";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { failureIssue, parentCompactSummary } from "../src/parent/presentation.ts";
import type { ParentConversation } from "../src/parent/transcript.ts";

const settled = (details: ParentConversation) =>
  parentCompactSummary({
    phase: "settled",
    args: { messages: 15 },
    result: { content: [], details },
    context: renderContextFixture({}),
  });

describe("parent conversation row", () => {
  it("reads neutrally, whatever the conversation holds", () => {
    const summary = settled({
      parentId: "019fd4cd-4c88-7564-8b67-3b917b42df51",
      requested: 15,
      items: [{ role: "user", text: "Ship it", tools: [] }],
      earlier: false,
      compacted: false,
    });
    // Reading the parent only looks, so the row is neutral.
    expect(summary?.outcome).toBe("returned");
  });

  it("names each failed read in the suite's issue style", () => {
    for (const failure of ["missing", "unreadable"] as const) {
      const issue = failureIssue({ failure, requested: 15 });
      expect(issueMessageStyleProblems(issue.message, { severity: issue.severity })).toEqual([]);
    }
  });
});
