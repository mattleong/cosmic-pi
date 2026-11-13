import { describe, expect, it } from "vitest";
import { createProfileOverrideHandoff } from "../src/application/profile-override-handoff.ts";
import {
  sessionProfileSnapshot,
  type SessionProfileOverrideSeed,
} from "../src/profiles/session-overrides.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import { completeBaseline, profileCandidate as candidate } from "./fixtures/profiles.ts";

const snapshot = (seed: SessionProfileOverrideSeed) =>
  sessionProfileSnapshot(resolveTestConfig({ version: 6, profileSets: {} }), seed);

const seed = (revision: number, model: string) =>
  snapshot({
    revision,
    overrides: { reviewer: { candidates: [candidate(model)] } },
    baseline: completeBaseline("project", `${model}-baseline`, "builtin"),
  });

describe("session profile override handoff", () => {
  it("survives an internal tree generation and rejects stale runtime publication", () => {
    const handoff = createProfileOverrideHandoff();
    expect(handoff.captureAuthoritative()).toBeUndefined();
    const first = handoff.open();
    handoff.publishSnapshot(first, seed(1, "openai/tree"));

    const treeSeed = handoff.capture();
    expect(treeSeed.overrides.reviewer?.candidates[0]?.model).toBe("openai/tree");
    expect(treeSeed.baseline?.profiles.reviewer.candidates[0]?.model).toBe("openai/tree-baseline");
    expect(handoff.captureAuthoritative()).toEqual(treeSeed);

    const second = handoff.open();
    expect(handoff.publishSnapshot(first, seed(2, "openai/stale"))).toBe(false);
    expect(handoff.capture()).toEqual(treeSeed);

    handoff.publishSnapshot(second, seed(2, "openai/after-tree"));
    expect(handoff.capture().overrides.reviewer?.candidates[0]?.model).toBe("openai/after-tree");
    expect(handoff.capture().baseline?.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/after-tree-baseline",
    );
  });

  it("clears at a real session lifecycle boundary and retires the open runtime", () => {
    const handoff = createProfileOverrideHandoff();
    const owner = handoff.open();
    handoff.publishSnapshot(
      owner,
      snapshot({ revision: 4, overrides: { scout: { candidates: [] } } }),
    );
    handoff.clear();
    expect(handoff.capture()).toEqual({ revision: 0, overrides: {} });
    expect(handoff.captureAuthoritative()).toBeUndefined();
    handoff.publishSnapshot(owner, seed(5, "openai/after-shutdown"));
    expect(handoff.captureAuthoritative()).toBeUndefined();
  });
});
