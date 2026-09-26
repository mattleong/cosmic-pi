import { describe, expect, it } from "vitest";
import { makeProfileOverrideHandoff } from "../src/application/profile-override-handoff.ts";
import { completeBaseline, profileCandidate as candidate } from "./fixtures/profiles.ts";

describe("session profile override handoff", () => {
  it("survives an internal tree generation and rejects stale runtime publication", () => {
    const handoff = makeProfileOverrideHandoff();
    expect(handoff.captureAuthoritative()).toBeUndefined();
    handoff.publish(1, 1, {
      revision: 1,
      overrides: { reviewer: { candidates: [candidate("openai/tree")] } },
      baseline: completeBaseline("project", "openai/tree-baseline", "builtin"),
    });

    const treeSeed = handoff.capture();
    expect(treeSeed.overrides.reviewer?.candidates[0]?.model).toBe("openai/tree");
    expect(treeSeed.baseline?.profiles.reviewer.candidates[0]?.model).toBe("openai/tree-baseline");
    expect(handoff.captureAuthoritative()).toEqual(treeSeed);

    handoff.publish(1, 2, {
      revision: 2,
      overrides: { reviewer: { candidates: [candidate("openai/stale")] } },
      baseline: completeBaseline("project", "openai/stale-baseline", "builtin"),
    });
    expect(handoff.capture()).toEqual(treeSeed);

    handoff.publish(2, 2, {
      revision: 2,
      overrides: { reviewer: { candidates: [candidate("openai/after-tree")] } },
      baseline: completeBaseline("project", "openai/after-tree-baseline", "builtin"),
    });
    expect(handoff.capture().overrides.reviewer?.candidates[0]?.model).toBe("openai/after-tree");
    expect(handoff.capture().baseline?.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/after-tree-baseline",
    );
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
