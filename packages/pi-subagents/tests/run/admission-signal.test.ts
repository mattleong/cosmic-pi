// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { ProfileRouteContinuation } from "../../src/profiles/model.ts";
import type { StartSubagentRequest } from "../../src/run/model.ts";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import { createOnlyWorkspaceEngine } from "../fixtures/workspace-engine.ts";
import { profileCandidate } from "../fixtures/profiles.ts";
import {
  contactParentFrame,
  fakeNativeReportBackendLayer,
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
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

const workflowRequest = (overrides: Partial<StartSubagentRequest> = {}) =>
  nativeReportRequest({
    name: "workflow-agent",
    workflow: { workflowId: "wf-test-1", name: "review" },
    ...overrides,
  });

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

describe("queued start checks", () => {
  it.effect(
    "admits queued workflow starts in order while they fit beside the main agent's reserve",
    () => {
      const { fake, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const nestingPolicy = { maxDirectChildren: 4, maxDepth: 3 };
        const queued = request({ name: "queued", nestingPolicy });
        // With no workflow agent running, the first start may take any slot; the next ones leave
        // two slots free for the main agent.
        expect(yield* service.queuedStartsAdmissible([queued, queued, queued], [])).toBe(2);
        yield* service.start(request({ name: "main-1", nestingPolicy }));
        yield* service.start(request({ name: "main-2", nestingPolicy }));
        expect(yield* service.queuedStartsAdmissible([queued, queued], [])).toBe(1);
        // A start already let through, which holds no slot yet, counts as a workflow agent.
        expect(yield* service.queuedStartsAdmissible([queued], ["agent-let-through"])).toBe(0);
        yield* service.start(request({ name: "main-3", nestingPolicy }));
        yield* service.start(request({ name: "main-4", nestingPolicy }));
        expect(yield* service.queuedStartsAdmissible([queued], [])).toBe(0);

        let revision = yield* service.admissionRevision;
        fake.controls[0]?.exit(1);
        // A queue's watcher: every release it waits for is one the check then sees.
        while ((yield* service.queuedStartsAdmissible([queued], [])) === 0) {
          yield* service.waitForAdmissionChange(revision);
          revision = yield* service.admissionRevision;
        }
        expect(yield* service.queuedStartsAdmissible([queued, queued], [])).toBe(1);
      });
    },
  );

  it.effect("counts a let-through start once while it initializes or acquires its worktree", () => {
    const started = Deferred.makeUnsafe<void>();
    const acquired = Deferred.makeUnsafe<void>();
    const progress = { creating: false };
    const fixture = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ initialStartGate: started }),
      {},
      profileLayerFor({ version: 6, nesting: { maxDirectChildren: 5, maxDepth: 3 } }),
    );
    const layer = fixture.layer.pipe(
      Layer.provide(
        Layer.succeed(
          WorkspaceService,
          // The checkout takes until `acquired` opens; `creating` notes the wait.
          createOnlyWorkspaceEngine(() =>
            Effect.sync(() => void (progress.creating = true)).pipe(
              Effect.andThen(Deferred.await(acquired)),
            ),
          ),
        ),
      ),
    );
    return withService(layer, function* (service) {
      const owner = { ownerId: "wf-test-1" };
      yield* service.openOwner(owner.ownerId);
      // One start is admitted and still starting its process; another acquires its worktree.
      const initializing = yield* service.reserveRunId;
      yield* service
        .startOwned(workflowRequest(), { ...owner, runId: initializing })
        .pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => fixture.projections.at(-1)?.runs.some((run) => run.id === initializing) === true,
      );
      const acquiring = yield* service.reserveRunId;
      yield* service
        .startOwned(
          workflowRequest({
            name: "isolated-writer",
            writeIntent: "writer",
            writerWorkspaceModeOverride: "worktree",
          }),
          { ...owner, runId: acquiring },
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => progress.creating);

      // Both hold one of the three slots beside the main agent's reserve, and count once.
      const queued = workflowRequest({ name: "queued" });
      const letThrough = [initializing, acquiring];
      expect(yield* service.queuedStartsAdmissible([queued, queued], letThrough)).toBe(1);
      // A let-through start that holds no slot yet takes the last one.
      expect(
        yield* service.queuedStartsAdmissible([queued], [...letThrough, "agent-let-through"]),
      ).toBe(0);
    });
  });

  it.effect("reports a writer conflict standing until the blocking writer loses its claim", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const holder = yield* claimHolder(service, fake, projections);
      const queued = writer("queued", ["src/b.ts"]);
      expect(yield* service.start(queued).pipe(Effect.flip)).toMatchObject({ transient: true });
      expect(yield* service.queuedWriterConflict(queued)).toMatchObject({ activeId: holder.id });
      // A worktree writer works in its own cwd, so the source's writers never block it.
      expect(
        yield* service.queuedWriterConflict({ ...queued, writerWorkspaceModeOverride: "worktree" }),
      ).toBeUndefined();

      yield* service.revokeWriteClaims(holder.id, ["src/b.ts"]);
      expect(yield* service.queuedWriterConflict(queued)).toBeUndefined();
      expect((yield* service.start(queued)).writeClaims).toEqual(["src/b.ts"]);
    });
  });
});
