import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { ProjectionError } from "pi-cosmic-core";
import { type ProfileRoute } from "../src/profiles/model.ts";
import {
  SessionProfileConflictError,
  SessionProfileInvalidError,
  sessionProfileSnapshot,
  sessionProfileSeed,
} from "../src/profiles/session-overrides.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import {
  builtProfileService,
  declaredCandidate,
  profileCandidate as candidate,
} from "./fixtures/profiles.ts";
import { stringContaining } from "./support/matchers.ts";

const route = (model: string): ProfileRoute => ({ candidates: [candidate(model)] });

const baseConfig = (projectReviewerModel = "openai/project") =>
  resolveTestConfig(
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: { default: { profiles: { reviewer: declaredCandidate("openai/global") } } },
      nesting: { maxDirectChildren: 20, maxDepth: 6 },
    },
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: {
        default: { profiles: { reviewer: declaredCandidate(projectReviewerModel) } },
      },
      nesting: { maxDirectChildren: 4, maxDepth: 2 },
    },
  );

describe("session profile overrides", () => {
  it.effect(
    "overlays complete routes above project configuration and clears without persistence",
    () =>
      Effect.gen(function* () {
        const published: Array<{ revision: number; baselineProfiles: number }> = [];
        const service = yield* builtProfileService(baseConfig(), {
          publishSession: (snapshot) =>
            published.push({
              revision: snapshot.revision,
              baselineProfiles: Object.keys(snapshot.baseline.profiles).length,
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
    const initial = sessionProfileSnapshot(baseConfig("openai/original"));
    const restored = sessionProfileSnapshot(
      baseConfig("openai/changed-on-disk"),
      sessionProfileSeed(initial),
    );

    expect(restored.baseConfig.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/changed-on-disk",
    );
    expect(restored.baseline.profiles.reviewer.candidates[0]?.model).toBe("openai/original");
    expect(restored.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/original");
  });

  it.effect("commits each edit together with its publication, even when interrupted there", () =>
    Effect.gen(function* () {
      const committing: Array<Fiber.Fiber<unknown, unknown>> = [];
      const published: number[] = [];
      let rejectPublication = false;
      const service = yield* builtProfileService(baseConfig(), {
        publishSession: (snapshot) => {
          if (rejectPublication) throw new Error("hostile session publication");
          published.push(snapshot.revision);
          committing[0]?.interruptUnsafe();
        },
      });
      const patch = (model: string, expectedRevision: number) =>
        service.patchSessionProfile({
          profile: "reviewer",
          route: route(model),
          expectedRevision,
        });
      rejectPublication = true;
      expect(yield* patch("openai/unpublished", 0).pipe(Effect.flip)).toBeInstanceOf(
        ProjectionError,
      );
      expect((yield* service.capture).revision).toBe(0);
      rejectPublication = false;

      const fiber = yield* Effect.forkChild(patch("openai/interrupted", 0));
      committing.push(fiber);
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
      expect(published).toEqual([0, 1]);
      const committed = yield* service.capture;
      expect(committed.revision).toBe(1);
      expect(committed.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
        "openai/interrupted",
      );
    }),
  );

  it.effect("reports a saved-set write as committed when session publication fails", () =>
    Effect.gen(function* () {
      let rejectPublication = false;
      const service = yield* builtProfileService(baseConfig(), {
        publishSession: () => {
          if (rejectPublication) throw new Error("hostile session publication");
        },
      });
      rejectPublication = true;
      const saved: number[] = [];
      const result = yield* service.withSnapshotAtRevision(0, (snapshot) =>
        Effect.sync(() => {
          saved.push(snapshot.revision);
          return "saved";
        }),
      );
      expect(result).toBe("saved");
      expect(saved).toEqual([0]);
    }),
  );

  it.effect("keeps a recorded writer workspace default without a Current Session revision", () =>
    Effect.gen(function* () {
      const published: Array<{ revision: number; mode: string }> = [];
      const service = yield* builtProfileService(baseConfig(), {
        publishSession: (snapshot) =>
          published.push({
            revision: snapshot.revision,
            mode: snapshot.baseConfig.writerWorkspaceMode,
          }),
      });
      const edited = yield* service.patchSessionProfile({
        profile: "reviewer",
        route: route("openai/session"),
        expectedRevision: 0,
      });
      yield* service.recordWriterWorkspaceMode("worktree");
      const current = yield* service.capture;
      expect(current.revision).toBe(edited.revision);
      expect(current.baseConfig.writerWorkspaceMode).toBe("worktree");
      expect(current.effectiveConfig.writerWorkspaceMode).toBe("worktree");
      expect(current.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe("openai/session");
      expect(published.at(-1)).toEqual({ revision: edited.revision, mode: "worktree" });
    }),
  );

  it.effect(
    "supports temporary disable, baseline restoration, no-op revisions, and stale-write rejection",
    () =>
      Effect.gen(function* () {
        const service = yield* builtProfileService(baseConfig());
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
          message: stringContaining("/subagents profiles"),
        });

        const conflict = yield* service
          .patchSessionProfile({
            profile: "scout",
            route: route("openai/stale"),
            expectedRevision: initial.revision,
          })
          .pipe(Effect.flip);
        expect(conflict).toBeInstanceOf(SessionProfileConflictError);
        expect(conflict).toMatchObject({
          expectedRevision: 0,
          actualRevision: 1,
        });

        const unchanged = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: { candidates: [] },
          expectedRevision: disabled.revision,
        });
        expect(unchanged.revision).toBe(disabled.revision);

        const cleared = yield* service.patchSessionProfile({
          profile: "reviewer",
          expectedRevision: unchanged.revision,
        });
        expect(cleared.revision).toBe(2);
        expect(cleared.overrides).toEqual({});
        expect(cleared.effectiveConfig.profileSources.reviewer).toBe("project");
      }),
  );

  it.effect(
    "atomically replaces the complete baseline, preserves nesting, and rejects stale replacement",
    () =>
      Effect.gen(function* () {
        const service = yield* builtProfileService(baseConfig());
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
        expect(replaced.effectiveConfig.nesting).toEqual({
          maxDirectChildren: 9,
          maxDepth: 4,
          maxActiveRuns: 16,
        });

        const edited = yield* service.patchSessionProfile({
          profile: "reviewer",
          route: route("openai/after-replace"),
          expectedRevision: replaced.revision,
        });
        const cleared = yield* service.patchSessionProfile({
          profile: "reviewer",
          expectedRevision: edited.revision,
        });
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
        expect(stale).toBeInstanceOf(SessionProfileConflictError);
        expect(stale).toMatchObject({
          expectedRevision: 0,
          actualRevision: cleared.revision,
        });
      }),
  );

  it.effect("merges a partial session nesting override over the activation-time policy", () =>
    Effect.gen(function* () {
      const service = yield* builtProfileService(baseConfig());
      const initial = yield* service.capture;
      expect(initial.effectiveConfig.nesting).toEqual({
        maxDirectChildren: 4,
        maxDepth: 2,
        maxActiveRuns: 16,
      });
      const nested = yield* service.patchSessionNesting({
        nesting: { maxDepth: 6 },
        expectedRevision: initial.revision,
      });
      expect(nested.effectiveConfig.nesting).toEqual({
        maxDirectChildren: 4,
        maxDepth: 6,
        maxActiveRuns: 16,
      });
      const cleared = yield* service.patchSessionNesting({
        nesting: {},
        expectedRevision: nested.revision,
      });
      expect(cleared.nesting).toBeUndefined();
      expect(cleared.effectiveConfig.nesting).toEqual(initial.effectiveConfig.nesting);
    }),
  );

  it.effect("rejects an edit that cannot apply as invalid, not as a revision conflict", () =>
    Effect.gen(function* () {
      const service = yield* builtProfileService(baseConfig());
      const initial = yield* service.capture;
      const invalid = yield* service
        .patchSessionNesting({
          nesting: { maxDirectChildren: -1, maxDepth: 0 },
          expectedRevision: initial.revision,
        })
        .pipe(Effect.flip);
      expect(invalid).toBeInstanceOf(SessionProfileInvalidError);
      expect((yield* service.capture).revision).toBe(initial.revision);

      const exhausted = yield* builtProfileService(baseConfig(), {
        initialSessionOverrides: { revision: Number.MAX_SAFE_INTEGER, overrides: {} },
      });
      const limited = yield* exhausted
        .patchSessionProfile({
          profile: "scout",
          route: route("openai/limit"),
          expectedRevision: Number.MAX_SAFE_INTEGER,
        })
        .pipe(Effect.flip);
      expect(limited).toBeInstanceOf(SessionProfileInvalidError);
      expect((yield* exhausted.capture).overrides).toEqual({});
    }),
  );

  it.effect("linearizes racing same-revision patches so exactly one commits", () =>
    Effect.gen(function* () {
      const service = yield* builtProfileService(baseConfig());
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
});
