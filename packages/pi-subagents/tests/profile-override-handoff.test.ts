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

const baseline = (reviewerModel: string) => ({
  origin: { scope: "project" as const, name: "saved" },
  profiles: {
    scout: { candidates: [candidate("parent")] },
    researcher: { candidates: [candidate("parent")] },
    planner: { candidates: [candidate("parent")] },
    worker: { candidates: [candidate("parent")] },
    reviewer: { candidates: [candidate(reviewerModel)] },
    oracle: { candidates: [candidate("parent")] },
    generalist: { candidates: [candidate("parent")] },
  },
  profileSources: {
    scout: "builtin" as const,
    researcher: "builtin" as const,
    planner: "builtin" as const,
    worker: "builtin" as const,
    reviewer: "project" as const,
    oracle: "builtin" as const,
    generalist: "builtin" as const,
  },
});

describe("session profile override handoff", () => {
  it("survives an internal tree generation and rejects stale runtime publication", () => {
    const handoff = makeProfileOverrideHandoff();
    expect(handoff.captureAuthoritative()).toBeUndefined();
    handoff.publish(1, 1, {
      revision: 1,
      overrides: { reviewer: { candidates: [candidate("openai/tree")] } },
      baseline: baseline("openai/tree-baseline"),
    });

    const treeSeed = handoff.capture();
    expect(treeSeed.overrides.reviewer?.candidates[0]?.model).toBe("openai/tree");
    expect(treeSeed.baseline?.profiles.reviewer.candidates[0]?.model).toBe("openai/tree-baseline");
    expect(handoff.captureAuthoritative()).toEqual(treeSeed);

    handoff.publish(1, 2, {
      revision: 2,
      overrides: { reviewer: { candidates: [candidate("openai/stale")] } },
      baseline: baseline("openai/stale-baseline"),
    });
    expect(handoff.capture()).toEqual(treeSeed);

    handoff.publish(2, 2, {
      revision: 2,
      overrides: { reviewer: { candidates: [candidate("openai/after-tree")] } },
      baseline: baseline("openai/after-tree-baseline"),
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
