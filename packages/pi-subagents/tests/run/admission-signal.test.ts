// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { ProfileRouteContinuation } from "../../src/profiles/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { profileCandidate } from "../fixtures/profiles.ts";
import {
  contactParentFrame,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

const continuation: ProfileRouteContinuation = {
  profile: "reviewer",
  routeSource: "global",
  candidates: [profileCandidate("openai-codex/gpt-5.6-sol"), profileCandidate("parent")],
  selectedCandidateIndex: 0,
  skippedCandidates: [],
};

const writer = (name: string, writes: ReadonlyArray<string>) =>
  request({ name, writeIntent: "writer", writes: [...writes] });

/** Holds `src/a.ts` and `src/b.ts` while waiting on a parent question, so claims can be revoked. */
const claimHolder = (
  service: SubagentServiceContract,
  fake: ReturnType<typeof localServiceFixture>["fake"],
  projections: ReturnType<typeof localServiceFixture>["projections"],
) =>
  Effect.gen(function* () {
    const holder = yield* service.start(writer("holder", ["src/a.ts", "src/b.ts"]));
    fake.controls[0]?.offer({
      type: "tool_execution_start",
      toolCallId: "q",
      toolName: "contact_parent",
      args: { kind: "question", message: "claims?" },
    });
    fake.controls[0]?.offerIpc(contactParentFrame("q", "question", "claims?"));
    yield* yieldUntil(
      () =>
        projections.at(-1)?.runs.find((run) => run.id === holder.id)?.state ===
        "waiting_for_parent",
    );
    return holder;
  });

describe("admission signal", () => {
  it.effect("wakes a writer queued on a file when the blocking writer loses its claim", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      // Claims can only be revoked while the writer waits on a parent question.
      const holder = yield* claimHolder(service, fake, projections);
      const before = yield* service.admissionRevision;
      const refused = yield* service.start(writer("queued", ["src/b.ts"])).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "SubagentWriterConflictError", transient: true });
      const waiting = yield* service.waitForAdmissionChange(before).pipe(Effect.forkScoped);

      yield* service.revokeWriteClaims(holder.id, ["src/b.ts"]);
      yield* Fiber.join(waiting);
      expect((yield* service.start(writer("queued", ["src/b.ts"]))).writeClaims).toEqual([
        "src/b.ts",
      ]);
    });
  });

  it.effect("wakes a writer queued behind a retry reservation when it is released", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failed = yield* service.start(
        request({
          profile: "worker",
          routeContinuation: continuation,
          writeIntent: "writer",
          writes: ["src/x.ts"],
        }),
      );
      fake.controls[0]?.exit(1);
      yield* yieldUntil(() => fake.controls[0]?.released() === 1);
      for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
      // No publication follows the reservation, so only the lock release can observe it.
      const claim = yield* service.claimRetryContinuation(failed.id);
      const before = yield* service.admissionRevision;
      const refused = yield* service.start(writer("queued", ["src/x.ts"])).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "SubagentWriterConflictError", transient: true });
      const waiting = yield* service.waitForAdmissionChange(before).pipe(Effect.forkScoped);

      yield* service.releaseRetryClaim(failed.id, claim.claimToken);
      yield* Fiber.join(waiting);
      expect((yield* service.start(writer("queued", ["src/x.ts"]))).state).toBe("running");
    });
  });
});

describe("queued start check", () => {
  it.effect("reports a capacity refusal standing until a direct child's slot is released", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const nestingPolicy = { maxDirectChildren: 1, maxDepth: 3 };
      yield* service.start(request({ name: "holder", nestingPolicy }));
      const queued = request({ name: "queued", nestingPolicy });
      expect(yield* service.start(queued).pipe(Effect.flip)).toMatchObject({
        code: "direct_child_capacity",
      });
      let revision = yield* service.admissionRevision;
      expect(yield* service.queuedStartRefused(queued, "capacity")).toBe(true);

      fake.controls[0]?.exit(1);
      // A queued owner's loop: every release it waits for is one the check then sees.
      while (yield* service.queuedStartRefused(queued, "capacity")) {
        yield* service.waitForAdmissionChange(revision);
        revision = yield* service.admissionRevision;
      }
      expect((yield* service.start(queued)).state).toBe("running");
    });
  });

  it.effect("reports a writer conflict standing until the blocking writer loses its claim", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const holder = yield* claimHolder(service, fake, projections);
      const queued = writer("queued", ["src/b.ts"]);
      expect(yield* service.start(queued).pipe(Effect.flip)).toMatchObject({ transient: true });
      expect(yield* service.queuedStartRefused(queued, "writer_conflict")).toBe(true);
      // A worktree writer works in its own cwd, so the source's writers never block it.
      expect(
        yield* service.queuedStartRefused(
          { ...queued, writerWorkspaceModeOverride: "worktree" },
          "writer_conflict",
        ),
      ).toBe(false);

      yield* service.revokeWriteClaims(holder.id, ["src/b.ts"]);
      expect(yield* service.queuedStartRefused(queued, "writer_conflict")).toBe(false);
      expect((yield* service.start(queued)).writeClaims).toEqual(["src/b.ts"]);
    });
  });
});
