import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { ProfileRouteContinuation } from "../../src/profiles/model.ts";
import { getFailedStartRecovery } from "../../src/run/launch.ts";
import { profileCandidate } from "../fixtures/profiles.ts";
import {
  fakeWriterLeaseLayer,
  leaseCounts,
  localServiceFixture,
  request,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";

const route = (index: number, intent: "read-only" | "writer"): ProfileRouteContinuation => ({
  profile: "reviewer",
  routeSource: "global",
  candidates: [
    profileCandidate("openai-codex/gpt-5.6-sol"),
    profileCandidate("parent", { writeIntent: intent }),
  ],
  selectedCandidateIndex: index,
  skippedCandidates: [],
});

describe("immutable script-origin subtree policy", () => {
  it.effect("inherits through authenticated readers and ignores spoofed parent ancestry", () => {
    const counts = leaseCounts();
    const f = localServiceFixture({}, undefined, undefined, fakeWriterLeaseLayer({ counts }));
    return withService(f.layer, function* (service) {
      const scripted = yield* service.startScriptSessionOwned(request());
      const unrelated = yield* service.startSessionOwned(request({ cwd: "/unrelated" }));
      const reader = yield* service.startSessionOwnedFrom(
        scripted.id,
        request({ parentRunId: unrelated.id, cwd: "/unrelated" }),
      );
      expect(reader).toMatchObject({ parentRunId: scripted.id, cwd: scripted.cwd, depth: 2 });
      for (const caller of [scripted.id, reader.id]) {
        const denied = yield* service
          .startSessionOwnedFrom(
            caller,
            request({
              writeIntent: "writer",
              parentRunId: unrelated.id,
              cwd: "/unrelated",
            }),
          )
          .pipe(Effect.flip);
        expect(denied).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
        expect(getFailedStartRecovery(denied)).toBeUndefined();
      }
      expect((yield* service.list).map((run) => run.id)).toEqual([
        scripted.id,
        unrelated.id,
        reader.id,
      ]);
      expect(counts.acquire).toBe(0);
      expect(counts.canonicalize).toBe(0);
      expect(f.fake.controls).toHaveLength(3);
    });
  });

  it.effect("preserves model-started nested writers and separately authorized root writers", () => {
    const f = localServiceFixture();
    return withService(f.layer, function* (service) {
      const scripted = yield* service.startScriptSessionOwned(request({ cwd: "/workflow" }));
      const model = yield* service.startSessionOwned(request({ cwd: "/model" }));
      const delegated = yield* service.startSessionOwnedFrom(
        model.id,
        request({ writeIntent: "writer" }),
      );
      const rootWriter = yield* service.startSessionOwned(
        request({ cwd: scripted.cwd, writeIntent: "writer" }),
      );
      expect(delegated).toMatchObject({
        parentRunId: model.id,
        writeIntent: "writer",
        state: "running",
      });
      expect(rootWriter).toMatchObject({
        parentRunId: "root",
        writeIntent: "writer",
        state: "running",
      });
    });
  });

  for (const state of ["paused", "completed"] as const)
    it.effect(
      `retains script ancestry after model-issued ${state === "paused" ? "in-place resume" : "completed respawn"}`,
      () => {
        const f = localServiceFixture();
        return withService(f.layer, function* (service) {
          const scripted = yield* service.startScriptSessionOwned(request());
          if (state === "paused") yield* service.interrupt(scripted.id);
          else {
            f.fake.controls[0]!.settle();
            yield* waitForCompleted(service, scripted.id);
            yield* yieldUntil(() => f.fake.controls[0]?.released() === 1);
          }
          const resumed = yield* service.resume(scripted.id);
          expect(resumed).toMatchObject({ id: scripted.id, state: "running" });
          expect(
            yield* service
              .startSessionOwnedFrom(scripted.id, request({ writeIntent: "writer" }))
              .pipe(Effect.flip),
          ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
          expect(yield* service.list).toHaveLength(1);
        });
      },
    );

  for (const scripted of [true, false])
    it.effect(
      `${scripted ? "refuses script-origin" : "preserves model-origin"} writer retry successors`,
      () => {
        const counts = leaseCounts();
        const f = localServiceFixture({}, undefined, undefined, fakeWriterLeaseLayer({ counts }));
        return withService(f.layer, function* (service) {
          const initial = request({ profile: "reviewer", routeContinuation: route(0, "writer") });
          const failed = yield* scripted
            ? service.startScriptSessionOwned(initial)
            : service.startSessionOwned(initial);
          f.fake.controls[0]!.exit(1);
          yield* yieldUntil(() => f.fake.controls[0]?.released() === 1);
          const claim = yield* service.claimRetryContinuation(failed.id);
          const retry = service.startRetrySessionOwned({
            ...request({
              profile: "reviewer",
              writeIntent: "writer",
              parentRunId: failed.parentRunId,
              routeContinuation: route(1, "writer"),
            }),
            supersedes: { runId: failed.id, claimToken: claim.claimToken },
          });
          if (!scripted) {
            const successor = yield* retry;
            expect(successor).toMatchObject({
              predecessorRunId: failed.id,
              parentRunId: failed.parentRunId,
              depth: failed.depth,
              writeIntent: "writer",
            });
            expect((yield* service.status(failed.id)).supersededByRunId).toBe(successor.id);
            return;
          }
          expect(yield* retry.pipe(Effect.flip)).toMatchObject({
            code: "scripted_subtree_writer_not_supported",
          });
          expect((yield* service.status(failed.id)).supersededByRunId).toBeUndefined();
          expect(yield* service.list).toHaveLength(1);
          expect(f.fake.controls).toHaveLength(1);
          expect(counts.acquire).toBe(0);
          expect(counts.canonicalize).toBe(0);
          const availableAgain = yield* service.claimRetryContinuation(failed.id);
          yield* service.releaseRetryClaim(failed.id, availableAgain.claimToken);
        });
      },
    );

  it.effect(
    "inherits predecessor provenance in read-only retries whose parent is the model root",
    () => {
      const f = localServiceFixture();
      return withService(f.layer, function* (service) {
        const failed = yield* service.startScriptSessionOwned(
          request({ profile: "reviewer", routeContinuation: route(0, "read-only") }),
        );
        f.fake.controls[0]!.exit(1);
        yield* yieldUntil(() => f.fake.controls[0]?.released() === 1);
        const claim = yield* service.claimRetryContinuation(failed.id);
        const successor = yield* service.startRetrySessionOwned({
          ...request({ profile: "reviewer", routeContinuation: route(1, "read-only") }),
          supersedes: { runId: failed.id, claimToken: claim.claimToken },
        });
        expect(successor).toMatchObject({
          parentRunId: "root",
          depth: failed.depth,
          predecessorRunId: failed.id,
          state: "running",
        });
        expect(
          yield* service
            .startSessionOwnedFrom(successor.id, request({ writeIntent: "writer" }))
            .pipe(Effect.flip),
        ).toMatchObject({ code: "scripted_subtree_writer_not_supported" });
      });
    },
  );
});
