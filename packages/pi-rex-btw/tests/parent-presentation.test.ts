import { describe, expect, it } from "vitest";
import { renderContextFixture } from "pi-code-previews/testing";
import { parentCompactSummary } from "../src/parent/presentation.ts";
import type { ParentConversation } from "../src/parent/transcript.ts";

const settled = (details: ParentConversation) =>
  parentCompactSummary({
    phase: "settled",
    args: { messages: 15 },
    result: { content: [], details },
    context: renderContextFixture({}),
  });

describe("parent conversation row", () => {
  it("reads neutrally, offering the messages it read", () => {
    const summary = settled({
      parentId: "019fd4cd-4c88-7564-8b67-3b917b42df51",
      requested: 15,
      items: [{ role: "user", text: "Ship it", tools: [] }],
      earlier: false,
      compacted: false,
    });
    // Reading the parent only looks, so the row is neutral, whatever the conversation holds.
    expect(summary?.outcome).toBe("returned");
    expect(summary?.expandLabel).toBe("messages");
  });
});
