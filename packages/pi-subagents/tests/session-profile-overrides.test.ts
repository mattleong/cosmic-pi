// Effect test entry points own the profile service lifecycle.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { BUILTIN_PROFILE_ROUTES } from "../src/profiles/definitions.ts";
import type { ProfileCandidate, ProfileRoute, ProfileRouteSource } from "../src/profiles/model.ts";
import { makeSubagentProfileService } from "../src/profiles/service.ts";
import {
  decodeSessionProfileOverrideSeed,
  makeSessionProfileSnapshot,
  MAX_SESSION_PROFILE_REVISION,
  patchSessionProfileSnapshot,
  replaceSessionProfileSnapshot,
  sessionProfileSeed,
  type SessionProfileBaseline,
} from "../src/profiles/session-overrides.ts";

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

const route = (model: string): ProfileRoute => ({ candidates: [candidate(model)] });

const completeSources = (source: ProfileRouteSource) => ({
  scout: source,
  researcher: source,
  planner: source,
  worker: source,
  reviewer: source,
  oracle: source,
  generalist: source,
});

const baseConfig = (projectReviewerModel = "openai/project") => {
  const global = decodeSubagentConfig(
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: { default: { profiles: { reviewer: candidate("openai/global") } } },
      nesting: { maxDirectChildren: 20, maxDepth: 6 },
    },
    "global",
  );
  const project = decodeSubagentConfig(
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: { default: { profiles: { reviewer: candidate(projectReviewerModel) } } },
      nesting: { maxDirectChildren: 4, maxDepth: 2 },
    },
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
        const published: Array<{ revision: number; baselineProfiles: number }> = [];
        const service = yield* makeSubagentProfileService(baseConfig(), {
          publishSessionOverrides: (seed) =>
            published.push({
              revision: seed.revision,
              baselineProfiles: Object.keys(seed.baseline?.profiles ?? {}).length,
            }),
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
        expect(published).toEqual([
          { revision: 0, baselineProfiles: 7 },
          { revision: 1, baselineProfiles: 7 },
          { revision: 2, baselineProfiles: 7 },
        ]);
      }),
  );

  it("restores an unedited frozen baseline without adopting changed saved defaults", () => {
    const initial = makeSessionProfileSnapshot(baseConfig("openai/original"));
    const restored = makeSessionProfileSnapshot(
      baseConfig("openai/changed-on-disk"),
      sessionProfileSeed(initial),
    );

    expect(restored.baseConfig.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/changed-on-disk",
    );
    expect(restored.baseline.profiles.reviewer.candidates[0]?.model).toBe("openai/original");
    expect(restored.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/original");
  });

  it("rejects impossible detached baseline provenance while retaining valid layering", () => {
    const baseline = makeSessionProfileSnapshot(baseConfig()).baseline;
    const decodeBaseline = (
      origin: SessionProfileBaseline["origin"],
      profiles: SessionProfileBaseline["profiles"],
      profileSources: SessionProfileBaseline["profileSources"],
    ) =>
      decodeSessionProfileOverrideSeed({
        revision: 0,
        overrides: {},
        baseline: { origin, profiles, profileSources },
      });

    expect(
      decodeBaseline({ scope: "builtin" }, BUILTIN_PROFILE_ROUTES, completeSources("builtin")),
    ).toBeDefined();
    expect(
      decodeBaseline(
        { scope: "builtin" },
        { ...BUILTIN_PROFILE_ROUTES, reviewer: route("openai/fabricated-builtin") },
        completeSources("builtin"),
      ),
    ).toBeUndefined();
    expect(
      decodeBaseline({ scope: "builtin" }, BUILTIN_PROFILE_ROUTES, {
        ...completeSources("builtin"),
        reviewer: "session",
      }),
    ).toBeUndefined();

    const globalProfiles = {
      ...BUILTIN_PROFILE_ROUTES,
      reviewer: route("openai/global"),
    };
    const globalSources = {
      ...completeSources("builtin"),
      reviewer: "global" as const,
    };
    expect(
      decodeBaseline({ scope: "global", name: "saved" }, globalProfiles, globalSources),
    ).toBeDefined();
    expect(
      decodeBaseline(
        { scope: "global", name: "saved" },
        { ...globalProfiles, scout: route("openai/fabricated-inherited-builtin") },
        globalSources,
      ),
    ).toBeUndefined();
    expect(
      decodeBaseline({ scope: "global", name: "saved" }, baseline.profiles, {
        ...completeSources("global"),
        reviewer: "project",
      }),
    ).toBeUndefined();
    const failClosedProfiles = {
      scout: { candidates: [] },
      researcher: { candidates: [] },
      planner: { candidates: [] },
      worker: { candidates: [] },
      reviewer: { candidates: [] },
      oracle: { candidates: [] },
      generalist: { candidates: [] },
    };
    expect(
      decodeBaseline(
        { scope: "global", name: "missing", invalid: true },
        failClosedProfiles,
        completeSources("global-invalid"),
      ),
    ).toBeDefined();
    expect(
      decodeBaseline(
        { scope: "global", name: "missing", invalid: true },
        failClosedProfiles,
        completeSources("global"),
      ),
    ).toBeUndefined();
    expect(
      decodeBaseline(
        { scope: "global", name: "missing", invalid: true },
        baseline.profiles,
        completeSources("global-invalid"),
      ),
    ).toBeUndefined();

    const projectWithInvalidGlobalFallback = {
      ...baseline.profiles,
      reviewer: { candidates: [] },
    };
    const projectSources = {
      ...completeSources("builtin"),
      reviewer: "global-invalid" as const,
    };
    expect(
      decodeBaseline(
        { scope: "project", name: "saved" },
        projectWithInvalidGlobalFallback,
        projectSources,
      ),
    ).toBeDefined();
    expect(
      decodeBaseline({ scope: "project", name: "saved" }, baseline.profiles, projectSources),
    ).toBeUndefined();
    expect(
      decodeBaseline(
        { scope: "project", name: "saved" },
        {
          ...projectWithInvalidGlobalFallback,
          scout: route("openai/fabricated-project-inheritance"),
        },
        projectSources,
      ),
    ).toBeUndefined();
  });

  it.effect("fails an invalid whole-baseline replacement without throwing", () =>
    Effect.gen(function* () {
      const initial = makeSessionProfileSnapshot(baseConfig());
      const failure = yield* replaceSessionProfileSnapshot(initial, {
        expectedRevision: initial.revision,
        origin: { scope: "builtin" },
        profiles: initial.baseline.profiles,
        profileSources: completeSources("project"),
      }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "SessionProfileConflictError",
        expectedRevision: initial.revision,
        actualRevision: initial.revision,
        message: expect.stringContaining("invalid routes or provenance"),
      });
    }),
  );

  it.effect("keeps identical whole-set replacements as no-ops through the maximum revision", () =>
    Effect.gen(function* () {
      const initial = makeSessionProfileSnapshot(baseConfig());
      const unchanged = yield* replaceSessionProfileSnapshot(initial, {
        expectedRevision: initial.revision,
        ...initial.baseline,
      });
      expect(unchanged).toBe(initial);
      expect(unchanged.revision).toBe(0);

      const maximum = makeSessionProfileSnapshot(baseConfig(), {
        ...sessionProfileSeed(initial),
        revision: MAX_SESSION_PROFILE_REVISION,
      });
      const unchangedAtMaximum = yield* replaceSessionProfileSnapshot(maximum, {
        expectedRevision: MAX_SESSION_PROFILE_REVISION,
        ...maximum.baseline,
      });
      expect(unchangedAtMaximum).toBe(maximum);
      expect(unchangedAtMaximum.revision).toBe(MAX_SESSION_PROFILE_REVISION);
    }),
  );

  it.effect("stops at the maximum exact revision without making a stale revision reusable", () =>
    Effect.gen(function* () {
      const decoded = decodeSessionProfileOverrideSeed({
        revision: MAX_SESSION_PROFILE_REVISION - 1,
        overrides: {},
      });
      expect(decoded).toBeDefined();
      if (!decoded) throw new Error("expected a valid maximum-minus-one revision seed");
      expect(
        decodeSessionProfileOverrideSeed({
          revision: MAX_SESSION_PROFILE_REVISION + 1,
          overrides: {},
        }),
      ).toBeUndefined();
      const initial = makeSessionProfileSnapshot(baseConfig(), decoded);
      const final = yield* patchSessionProfileSnapshot(initial, {
        profile: "reviewer",
        route: route("openai/final-safe-revision"),
        expectedRevision: MAX_SESSION_PROFILE_REVISION - 1,
      });
      expect(final.revision).toBe(MAX_SESSION_PROFILE_REVISION);

      const stale = yield* patchSessionProfileSnapshot(final, {
        profile: "scout",
        route: route("openai/stale"),
        expectedRevision: MAX_SESSION_PROFILE_REVISION - 1,
      }).pipe(Effect.flip);
      expect(stale).toMatchObject({
        _tag: "SessionProfileConflictError",
        actualRevision: MAX_SESSION_PROFILE_REVISION,
      });

      const exhausted = yield* patchSessionProfileSnapshot(final, {
        profile: "scout",
        route: route("openai/would-saturate"),
        expectedRevision: MAX_SESSION_PROFILE_REVISION,
      }).pipe(Effect.flip);
      expect(exhausted).toMatchObject({
        _tag: "SessionProfileConflictError",
        expectedRevision: MAX_SESSION_PROFILE_REVISION,
        actualRevision: MAX_SESSION_PROFILE_REVISION,
        message: expect.stringContaining("exact-integer limit"),
      });
    }),
  );

  it.effect("overlays and clears strict session nesting policy", () =>
    Effect.gen(function* () {
      const service = yield* makeSubagentProfileService(baseConfig());
      const initial = yield* service.capture;
      expect(initial.effectiveConfig.nesting).toEqual({ maxDirectChildren: 4, maxDepth: 2 });
      expect(initial.effectiveConfig.nestingSource).toBe("project");

      const overridden = yield* service.patchSessionNesting({
        nesting: { maxDirectChildren: 7, maxDepth: 5 },
        expectedRevision: initial.revision,
      });
      expect(overridden.effectiveConfig.nesting).toEqual({
        maxDirectChildren: 7,
        maxDepth: 5,
      });
      expect(overridden.effectiveConfig.nestingSource).toBe("session");

      const cleared = yield* service.patchSessionNesting({
        expectedRevision: overridden.revision,
      });
      expect(cleared.effectiveConfig.nesting).toEqual({ maxDirectChildren: 4, maxDepth: 2 });
      expect(cleared.effectiveConfig.nestingSource).toBe("project");
    }),
  );

  it.effect("commits session state when publication throws", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const service = yield* makeSubagentProfileService(baseConfig(), {
        publishSessionOverrides: () => {
          attempts += 1;
          throw new Error("hostile session publication");
        },
      });
      const committed = yield* service.patchSessionProfile({
        profile: "reviewer",
        route: route("openai/session-after-throw"),
        expectedRevision: 0,
      });
      const captured = yield* service.capture;

      expect(attempts).toBe(2);
      expect(committed.revision).toBe(1);
      expect(captured).toEqual(committed);
      expect(captured.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
        "openai/session-after-throw",
      );
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
          message: expect.stringContaining("/subagents profiles"),
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

  it.effect(
    "atomically replaces the complete baseline, preserves nesting, and rejects stale replacement",
    () =>
      Effect.gen(function* () {
        const service = yield* makeSubagentProfileService(baseConfig());
        const initial = yield* service.capture;
        const nested = yield* service.patchSessionNesting({
          nesting: { maxDirectChildren: 9, maxDepth: 4 },
          expectedRevision: initial.revision,
        });
        const sparse = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: route("openai/sparse"),
          expectedRevision: nested.revision,
        });
        const replacementProfiles = {
          ...sparse.baseline.profiles,
          reviewer: route("openai/replacement"),
        };
        const replacementSources = {
          ...sparse.baseline.profileSources,
          reviewer: "global" as const,
        };
        const replaced = yield* service.replaceSessionProfiles({
          expectedRevision: sparse.revision,
          origin: { scope: "global", name: "saved" },
          profiles: replacementProfiles,
          profileSources: replacementSources,
        });

        expect(replaced.revision).toBe(sparse.revision + 1);
        expect(replaced.overrides).toEqual({});
        expect(replaced.baseline.origin).toEqual({ scope: "global", name: "saved" });
        expect(replaced.baseline.profiles.reviewer).not.toBe(replacementProfiles.reviewer);
        expect(replaced.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
          "openai/replacement",
        );
        expect(replaced.effectiveConfig.nesting).toEqual({ maxDirectChildren: 9, maxDepth: 4 });
        expect(replaced.effectiveConfig.nestingSource).toBe("session");

        const edited = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: route("openai/after-replace"),
          expectedRevision: replaced.revision,
        });
        const cleared = yield* service.clearSessionProfiles(edited.revision);
        expect(cleared.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
          "openai/replacement",
        );

        const stale = yield* service
          .replaceSessionProfiles({
            expectedRevision: initial.revision,
            origin: { scope: "project", name: "stale" },
            profiles: initial.baseline.profiles,
            profileSources: initial.baseline.profileSources,
          })
          .pipe(Effect.flip);
        expect(stale).toMatchObject({
          _tag: "SessionProfileConflictError",
          expectedRevision: 0,
          actualRevision: cleared.revision,
        });
      }),
  );

  it.effect("linearizes a whole-set replace racing a clear", () =>
    Effect.gen(function* () {
      const service = yield* makeSubagentProfileService(baseConfig());
      const initial = yield* service.capture;
      const sparse = yield* service.patchSessionProfile({
        profile: "reviewer",
        route: route("openai/sparse"),
        expectedRevision: initial.revision,
      });
      const outcomes = yield* Effect.all(
        [
          Effect.exit(
            service.replaceSessionProfiles({
              expectedRevision: sparse.revision,
              origin: { scope: "global", name: "racing-set" },
              profiles: sparse.baseline.profiles,
              profileSources: sparse.baseline.profileSources,
            }),
          ),
          Effect.exit(service.clearSessionProfiles(sparse.revision)),
        ],
        { concurrency: "unbounded" },
      );

      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
      expect((yield* service.capture).revision).toBe(sparse.revision + 1);
    }),
  );

  it.effect("compares every candidate field when suppressing no-op revisions", () =>
    Effect.gen(function* () {
      const original = candidate("openai/base");
      const variants: ReadonlyArray<ProfileCandidate> = [
        { ...original, host: "herdr" },
        { ...original, runtime: "codex" },
        { ...original, model: "openai/other" },
        { ...original, effort: "off" },
        { ...original, context: "fork" },
        { ...original, writeIntent: "writer" },
        { ...original, openaiFastMode: true },
        { ...original, closeOnReport: false },
      ];

      for (const changed of variants) {
        const initial = makeSessionProfileSnapshot(baseConfig());
        const committed = yield* patchSessionProfileSnapshot(initial, {
          profile: "reviewer",
          route: { candidates: [changed] },
          expectedRevision: 0,
        });
        expect(committed.revision).toBe(1);
        const unchanged = yield* patchSessionProfileSnapshot(committed, {
          profile: "reviewer",
          route: { candidates: [{ ...changed }] },
          expectedRevision: 1,
        });
        expect(unchanged.revision).toBe(1);
      }
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
