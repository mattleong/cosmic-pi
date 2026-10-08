import { describe, expect, it } from "vitest";
import { makeProfileOverrideHandoff } from "../src/application/profile-override-handoff.ts";
import { completeBaseline, profileCandidate as candidate } from "./fixtures/profiles.ts";

const seed = (revision: number, model: string) => ({
  revision,
  overrides: { reviewer: { candidates: [candidate(model)] } },
  baseline: completeBaseline("project", `${model}-baseline`, "builtin"),
});

describe("session profile override handoff", () => {
  it("survives an internal tree generation and rejects stale runtime publication", () => {
    const handoff = makeProfileOverrideHandoff();
    expect(handoff.captureAuthoritative()).toBeUndefined();
    const first = handoff.open();
    handoff.publish(first, seed(1, "openai/tree"));

    const treeSeed = handoff.capture();
    expect(treeSeed.overrides.reviewer?.candidates[0]?.model).toBe("openai/tree");
    expect(treeSeed.baseline?.profiles.reviewer.candidates[0]?.model).toBe("openai/tree-baseline");
    expect(handoff.captureAuthoritative()).toEqual(treeSeed);

    const second = handoff.open();
    handoff.publish(first, seed(2, "openai/stale"));
    expect(handoff.capture()).toEqual(treeSeed);

    handoff.publish(second, seed(2, "openai/after-tree"));
    expect(handoff.capture().overrides.reviewer?.candidates[0]?.model).toBe("openai/after-tree");
    expect(handoff.capture().baseline?.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/after-tree-baseline",
    );
  });

  it("clears at a real session lifecycle boundary and retires the open runtime", () => {
    const handoff = makeProfileOverrideHandoff();
    const owner = handoff.open();
    handoff.publish(owner, { revision: 4, overrides: { scout: { candidates: [] } } });
    handoff.clear();
    expect(handoff.capture()).toEqual({ revision: 0, overrides: {} });
    expect(handoff.captureAuthoritative()).toBeUndefined();
    handoff.publish(owner, seed(5, "openai/after-shutdown"));
    expect(handoff.captureAuthoritative()).toBeUndefined();
  });
});
