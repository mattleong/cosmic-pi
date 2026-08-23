// Effect test entry points own the profile service lifecycle.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  it.effect(
    "overlays complete routes above project configuration and clears without persistence",
    () =>
      Effect.gen(function* () {
        const published: number[] = [];
        const service = yield* makeSubagentProfileService(baseConfig(), {
          publishSessionOverrides: (seed) => published.push(seed.revision),
        });
        const initial = yield* service.capture;
        expect(initial.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
          "openai/project",
        );
        expect(initial.effectiveConfig.profileSources.reviewer).toBe("project");

        const overridden = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: route("openai/session"),
          expectedRevision: initial.revision,
        });
        expect(overridden.revision).toBe(1);
        expect(overridden.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
          "openai/session",
        );
        expect(overridden.effectiveConfig.profileSources.reviewer).toBe("session");

        const cleared = yield* service.patchSessionProfile({
          profile: "reviewer",
          expectedRevision: overridden.revision,
        });
        expect(cleared.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
          "openai/project",
        );
        expect(cleared.effectiveConfig.profileSources.reviewer).toBe("project");
        expect(published).toEqual([1, 2]);
      }),
  );

  it.effect(
    "supports temporary disable, clear-all, no-op revisions, and stale-write rejection",
    () =>
      Effect.gen(function* () {
        const service = yield* makeSubagentProfileService(baseConfig());
        const initial = yield* service.capture;
        const disabled = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: { candidates: [] },
          expectedRevision: initial.revision,
        });
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

        const conflict = yield* service
          .patchSessionProfile({
            profile: "scout",
            route: route("openai/stale"),
            expectedRevision: initial.revision,
          })
          .pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "SessionProfileConflictError",
          expectedRevision: 0,
          actualRevision: 1,
        });

        const unchanged = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: { candidates: [] },
          expectedRevision: disabled.revision,
        });
        expect(unchanged.revision).toBe(disabled.revision);

        const cleared = yield* service.clearSessionProfiles(unchanged.revision);
        expect(cleared.revision).toBe(2);
        expect(cleared.overrides).toEqual({});
        expect(cleared.effectiveConfig.profileSources.reviewer).toBe("project");
      }),
  );

  it.effect("linearizes racing same-revision patches so exactly one commits", () =>
    Effect.gen(function* () {
      const service = yield* makeSubagentProfileService(baseConfig());
      const initial = yield* service.capture;
      const outcomes = yield* Effect.all(
        [
          Effect.exit(
            service.patchSessionProfile({
              profile: "scout",
              route: route("openai/one"),
              expectedRevision: initial.revision,
            }),
          ),
          Effect.exit(
            service.patchSessionProfile({
              profile: "reviewer",
              route: route("openai/two"),
              expectedRevision: initial.revision,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
      const snapshot = yield* service.capture;
      expect(snapshot.revision).toBe(1);
      expect(Object.keys(snapshot.overrides)).toHaveLength(1);
    }),
  );

  it.effect("allows a session route to repair an invalid loaded project route temporarily", () =>
    Effect.gen(function* () {
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
      const repaired = yield* patchSessionProfileSnapshot(initial, {
        profile: "reviewer",
        route: route("openai/repair"),
        expectedRevision: 0,
      });
      expect(repaired.effectiveConfig.profileSources.reviewer).toBe("session");
      expect(repaired.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/repair");
    }),
  );
});
