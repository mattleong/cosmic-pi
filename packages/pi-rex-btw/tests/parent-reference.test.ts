import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { registerParentReference } from "../src/parent-reference.ts";

const PARENT_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const SECTION = "rex_btw_parent_reference";

const harness = (flags: Record<string, string | undefined>, existing: Set<string>) => {
  const { pi, handlers } = recordingExtensionHost(
    {},
    { registerFlag() {}, getFlag: (name: string) => flags[name] },
  );
  registerParentReference(pi, { fileExists: (path) => existing.has(path) });
  const sections: BeforeAgentStartEvent["systemPromptOptions"]["sections"] = {
    another_extension: "keep me",
  };
  const run = () => {
    for (const handler of handlers.get("before_agent_start")) {
      const result = handler(
        {
          type: "before_agent_start",
          messageType: "user",
          prompt: "p",
          systemPrompt: "base",
          systemPromptOptions: {
            cwd: "/project",
            selectedTools: [],
            hiddenTools: [],
            toolSnippets: {},
            toolGuidelines: {},
            promptGuidelines: [],
            appendSystemPrompt: "",
            sections,
            contextFiles: [],
            skills: [],
          },
        },
        extensionContextFixture({}),
      );
      expect(result).toBeUndefined();
    }
    expect(sections.another_extension).toBe("keep me");
    return sections[SECTION];
  };
  return { run };
};

describe("parent reference", () => {
  it("tells a BTW child where the live parent transcript is on every run", () => {
    const parentFile = '/sessions/parent "quoted".jsonl';
    const existing = new Set([parentFile]);
    const h = harness({ "rex-btw-parent": PARENT_ID, "rex-btw-parent-file": parentFile }, existing);
    const note = h.run();
    expect(note).toContain(JSON.stringify(parentFile));
    expect(note).toContain(PARENT_ID);
    expect(h.run()).toBe(note);

    existing.delete(parentFile);
    expect(h.run()).toBeUndefined();
  });

  it("adds nothing to ordinary sessions or malformed markers", () => {
    expect(harness({}, new Set()).run()).toBeUndefined();
    expect(
      harness(
        { "rex-btw-parent": PARENT_ID, "rex-btw-parent-file": "relative.jsonl" },
        new Set(["relative.jsonl"]),
      ).run(),
    ).toBeUndefined();
  });
});
