import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { type ProfileRoute } from "../src/profiles/model.ts";
import { makeSubagentProfileService } from "../src/profiles/service.ts";
import {
  SessionProfileConflictError,
  sessionProfileSnapshot,
  sessionProfileSeed,
} from "../src/profiles/session-overrides.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import { profileCandidate as candidate } from "./fixtures/profiles.ts";
import { stringContaining } from "./support/matchers.ts";

const route = (model: string): ProfileRoute => ({ candidates: [candidate(model)] });

const baseConfig = (projectReviewerModel = "openai/project") =>
  resolveTestConfig(
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: { default: { profiles: { reviewer: candidate("openai/global") } } },
      nesting: { maxDirectChildren: 20, maxDepth: 6 },
    },
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: { default: { profiles: { reviewer: candidate(projectReviewerModel) } } },
      nesting: { maxDirectChildren: 4, maxDepth: 2 },
    },
  );

describe("session profile overrides", () => {
  it.effect(
    "overlays complete routes above project configuration and clears without persistence",
    () =>
      Effect.gen(function* () {
        const published: Array<{ revision: number; baselineProfiles: number }> = [];
        const service = yield* makeSubagentProfileService(baseConfig(), {
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

  it.effect(
    "commits each edit with its best-effort handoff publication, even interrupted there",
    () =>
      Effect.gen(function* () {
        const committing: Array<Fiber.Fiber<unknown, unknown>> = [];
        const published: number[] = [];
        const service = yield* makeSubagentProfileService(baseConfig(), {
          publishSession: (snapshot) => {
            published.push(snapshot.revision);
            committing[0]?.interruptUnsafe();
            throw new Error("hostile session publication");
          },
        });
        const patch = (model: string, expectedRevision: number) =>
          service.patchSessionProfile({
            profile: "reviewer",
            route: route(model),
            expectedRevision,
          });
        const committed = yield* patch("openai/session-after-throw", 0);
        expect(yield* service.capture).toEqual(committed);
        expect(committed.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
          "openai/session-after-throw",
        );

        const fiber = yield* Effect.forkChild(patch("openai/interrupted", committed.revision));
        committing.push(fiber);
        expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
        expect(published).toEqual([0, 1, 2]);
        expect((yield* service.capture).revision).toBe(2);
      }),
  );

  it.effect(
    "supports temporary disable, baseline restoration, no-op revisions, and stale-write rejection",
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
});
