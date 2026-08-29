import { describe, expect, it } from "vitest";
import { makeProfileOverrideHandoff } from "../src/application/profile-override-handoff.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";

const candidate = (model: string): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  closeOnReport: true,
});

describe("session profile override handoff", () => {
  it("survives an internal tree generation and rejects stale runtime publication", () => {
    const handoff = makeProfileOverrideHandoff();
    expect(handoff.captureAuthoritative()).toBeUndefined();
    handoff.publish(1, 1, {
      revision: 1,
      overrides: { reviewer: { candidates: [candidate("openai/tree")] } },
    });

    const treeSeed = handoff.capture();
    expect(treeSeed.overrides.reviewer?.candidates[0]?.model).toBe("openai/tree");
    expect(handoff.captureAuthoritative()).toEqual(treeSeed);

    handoff.publish(1, 2, {
      revision: 2,
      overrides: { reviewer: { candidates: [candidate("openai/stale")] } },
    });
    expect(handoff.capture()).toEqual(treeSeed);

    handoff.publish(2, 2, {
      revision: 2,
      overrides: { reviewer: { candidates: [candidate("openai/after-tree")] } },
    });
    expect(handoff.capture().overrides.reviewer?.candidates[0]?.model).toBe("openai/after-tree");
  });

  it("clears at a real session lifecycle boundary", () => {
    const handoff = makeProfileOverrideHandoff();
    handoff.publish(1, 1, {
      revision: 4,
      overrides: { scout: { candidates: [] } },
    });
    handoff.clear();
    expect(handoff.capture()).toEqual({ revision: 0, overrides: {} });
    expect(handoff.captureAuthoritative()).toBeUndefined();
  });
});
