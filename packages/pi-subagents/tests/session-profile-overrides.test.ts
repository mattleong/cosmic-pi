// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { ProfileCandidate, ProfileRoute } from "../src/profiles/model.ts";
import { makeSubagentProfileService } from "../src/profiles/service.ts";
import {
  makeSessionProfileSnapshot,
  patchSessionProfileSnapshot,
} from "../src/profiles/session-overrides.ts";

const candidate = (model: string): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  closeOnReport: true,
});

const route = (model: string): ProfileRoute => ({ candidates: [candidate(model)] });

const baseConfig = () => {
  const global = decodeSubagentConfig(
    { version: 4, profiles: { reviewer: candidate("openai/global") } },
    "global",
  );
  const project = decodeSubagentConfig(
    { version: 4, profiles: { reviewer: candidate("openai/project") } },
    "project",
  );
  return resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: true,
    global,
    project,
  });
};

describe("session profile overrides", () => {
  it("overlays complete routes above project configuration and clears without persistence", async () => {
    const published: number[] = [];
    const service = await Effect.runPromise(
      makeSubagentProfileService(baseConfig(), {
        publishSessionOverrides: (seed) => published.push(seed.revision),
      }),
    );
    const initial = await Effect.runPromise(service.capture);
    expect(initial.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/project");
    expect(initial.effectiveConfig.profileSources.reviewer).toBe("project");

    const overridden = await Effect.runPromise(
      service.patchSessionProfile({
        profile: "reviewer",
        route: route("openai/session"),
        expectedRevision: initial.revision,
      }),
    );
    expect(overridden.revision).toBe(1);
    expect(overridden.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/session",
    );
    expect(overridden.effectiveConfig.profileSources.reviewer).toBe("session");

    const cleared = await Effect.runPromise(
      service.patchSessionProfile({
        profile: "reviewer",
        expectedRevision: overridden.revision,
      }),
    );
    expect(cleared.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/project");
    expect(cleared.effectiveConfig.profileSources.reviewer).toBe("project");
    expect(published).toEqual([1, 2]);
  });

  it("supports temporary disable, clear-all, no-op revisions, and stale-write rejection", async () => {
    const service = await Effect.runPromise(makeSubagentProfileService(baseConfig()));
    const initial = await Effect.runPromise(service.capture);
    const disabled = await Effect.runPromise(
      service.patchSessionProfile({
        profile: "reviewer",
        route: { candidates: [] },
        expectedRevision: initial.revision,
      }),
    );
    expect(disabled.effectiveConfig.profiles.reviewer.candidates).toEqual([]);
    expect(disabled.effectiveConfig.profileSources.reviewer).toBe("session");
    expect(
      service.resolve(disabled, "reviewer", {
        availablePiModels: [],
        forkAvailable: false,
      }),
    ).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("/subagents profiles session"),
    });

    await expect(
      Effect.runPromise(
        service.patchSessionProfile({
          profile: "scout",
          route: route("openai/stale"),
          expectedRevision: initial.revision,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SessionProfileConflictError",
      expectedRevision: 0,
      actualRevision: 1,
    });

    const unchanged = await Effect.runPromise(
      service.patchSessionProfile({
        profile: "reviewer",
        route: { candidates: [] },
        expectedRevision: disabled.revision,
      }),
    );
    expect(unchanged.revision).toBe(disabled.revision);

    const cleared = await Effect.runPromise(service.clearSessionProfiles(unchanged.revision));
    expect(cleared.revision).toBe(2);
    expect(cleared.overrides).toEqual({});
    expect(cleared.effectiveConfig.profileSources.reviewer).toBe("project");
  });

  it("linearizes racing same-revision patches so exactly one commits", async () => {
    const service = await Effect.runPromise(makeSubagentProfileService(baseConfig()));
    const initial = await Effect.runPromise(service.capture);
    const outcomes = await Promise.allSettled([
      Effect.runPromise(
        service.patchSessionProfile({
          profile: "scout",
          route: route("openai/one"),
          expectedRevision: initial.revision,
        }),
      ),
      Effect.runPromise(
        service.patchSessionProfile({
          profile: "reviewer",
          route: route("openai/two"),
          expectedRevision: initial.revision,
        }),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const snapshot = await Effect.runPromise(service.capture);
    expect(snapshot.revision).toBe(1);
    expect(Object.keys(snapshot.overrides)).toHaveLength(1);
  });

  it("allows a session route to repair an invalid loaded project route temporarily", async () => {
    const global = decodeSubagentConfig({ version: 4 }, "global");
    const project = decodeSubagentConfig({ version: 4, profiles: { reviewer: null } }, "project");
    const base = resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: true,
      globalConfigExists: true,
      projectConfigExists: true,
      global,
      project,
    });
    const initial = makeSessionProfileSnapshot(base);
    expect(initial.effectiveConfig.profileSources.reviewer).toBe("project-invalid");
    const repaired = await Effect.runPromise(
      patchSessionProfileSnapshot(initial, {
        profile: "reviewer",
        route: route("openai/repair"),
        expectedRevision: 0,
      }),
    );
    expect(repaired.effectiveConfig.profileSources.reviewer).toBe("session");
    expect(repaired.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/repair");
  });
});
