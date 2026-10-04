// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import { compileResultContract } from "../../src/domain/result-contract.ts";
import { childSystemPrompt } from "../../src/run/tool-policy.ts";
import { subagentErrorCode as errorCode } from "../../src/run/errors.ts";
import {
  emptyUsage,
  type StartSubagentRequest,
  type SubagentProjection,
} from "../../src/run/model.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import { createOnlyWorkspaceEngine } from "../fixtures/workspace-engine.ts";
import {
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
  withService,
  awaitRuns,
} from "./fixtures/service-harness.ts";

const OWNER = "wf-test-1";
const owner = { ownerId: OWNER } as const;

const ownedRequest = (overrides: Partial<StartSubagentRequest> = {}) =>
  nativeReportRequest({
    name: "find-issues",
    workflow: { workflowId: OWNER, name: "review", phase: "Find" },
    ...overrides,
  });

const parentContactBackend = () =>
  fakeNativeReportBackendLayer({
    capabilities: ["steer", "interrupt", "resume", "rename-display", "parent-contact"],
  });

const stateOf = (projections: ReadonlyArray<SubagentProjection>, id: string) =>
  projections.at(-1)?.runs.find((run) => run.id === id)?.state;

const rootOutcomes = (notifications: ReadonlyArray<SubagentNotification>) =>
  notifications.flatMap((notification) =>
    notification.type === "completed" ? notification.runs.map((run) => run.id) : [],
  );

const questions = (notifications: ReadonlyArray<SubagentNotification>) =>
  notifications.filter(
    (notification): notification is Extract<SubagentNotification, { type: "question" }> =>
      notification.type === "question",
  );

/** Lets every delivery worker run past its retry delay. */
const drainDelivery = TestClock.adjust("5 seconds");

describe("owned subagent runs", () => {
  it.effect("keeps a report that settles during startup away from root delivery", () => {
    const startGate = Deferred.makeUnsafe<void>();
    const { backend, projections, notifications, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ initialStartGate: startGate }),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const runId = yield* service.reserveRunId;
      const starting = yield* service
        .startOwned(ownedRequest(), { ...owner, runId })
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.prompts.length === 1);
      backend.controls[0]!.report(runId, 1, "fast", "Found three issues.");
      yield* Deferred.succeed(startGate, undefined);
      const handle = yield* Fiber.join(starting);
      expect(handle.runId).toBe(runId);
      yield* yieldUntil(() => stateOf(projections, runId) === "completed");
      expect(projections.at(-1)?.runs.find((run) => run.id === runId)?.workflow).toEqual({
        workflowId: OWNER,
        name: "review",
        phase: "Find",
      });
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([]);

      expect(yield* service.awaitOwned(handle)).toMatchObject({
        kind: "completed",
        text: "Found three issues.",
      });
      const again = yield* service.awaitOwned(handle).pipe(Effect.flip);
      expect(errorCode(again)).toBe("owned_run_released");
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([]);
    });
  });

  it.effect("carries the tool calls and usage an owned run spent into its outcome", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest(), owner);
      const control = backend.controls[0]!;
      // Handing back a structured result isn't counted as a tool use.
      for (const [toolCallId, toolName] of [
        ["result-1", "subagent_result"],
        ["read-1", "read"],
        ["read-2", "read"],
        ["read-3", "read"],
      ])
        control.offer({
          type: "tool_started",
          assignmentEpoch: control.assignmentEpochs.at(-1) ?? 1,
          toolCallId: toolCallId!,
          toolName: toolName!,
          args: { path: "src/a.ts" },
        });
      control.offer({ type: "usage", usage: { ...emptyUsage(), output: 9, totalTokens: 90 } });
      yield* yieldUntil(
        () => projections.at(-1)?.runs.find((run) => run.id === handle.runId)?.toolUses === 3,
      );
      control.report(handle.runId, 1, "done", "Found three issues.");
      expect(yield* service.awaitOwned(handle)).toMatchObject({
        kind: "completed",
        toolUses: 3,
        usage: { output: 9, totalTokens: 90 },
      });
    });
  });

  it.effect("resolves a stopped owned run as stopped without notifying the root", () => {
    const { notifications, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest(), owner);
      const waiting = yield* service.awaitOwned(handle).pipe(Effect.forkScoped);
      yield* service.stop(handle.runId);
      expect((yield* Fiber.join(waiting)).kind).toBe("stopped");
      yield* drainDelivery;
      expect(notifications).toEqual([]);
    });
  });

  it.effect("resolves a failed owned run as failed without notifying the root", () => {
    const { backend, notifications, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest(), owner);
      const waiting = yield* service.awaitOwned(handle).pipe(Effect.forkScoped);
      backend.controls[0]!.offer({ type: "protocol_error", message: "Malformed frame." });
      const outcome = yield* Fiber.join(waiting);
      expect(outcome.kind).toBe("failed");
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([]);
    });
  });

  it.effect("keeps waiting while an owned run asks the root or is paused", () => {
    const { backend, projections, notifications, layer } =
      nativeReportServiceFixture(parentContactBackend());
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest(), owner);
      const waiting = yield* service.awaitOwned(handle).pipe(Effect.forkScoped);
      backend.controls[0]!.offer({
        type: "supervisor_contact",
        assignmentEpoch: 1,
        requestId: "question-1",
        kind: "question",
        message: "Which module?",
      });
      yield* yieldUntil(() => stateOf(projections, handle.runId) === "waiting_for_parent");
      yield* drainDelivery;
      expect(questions(notifications)).toEqual([
        expect.objectContaining({
          id: handle.runId,
          workflow: expect.objectContaining({ workflowId: OWNER }),
        }),
      ]);
      expect(waiting.pollUnsafe()).toBeUndefined();

      yield* service.reply(handle.runId, "Use the auth module.");
      expect((yield* service.interrupt(handle.runId)).state).toBe("paused");
      yield* drainDelivery;
      expect(waiting.pollUnsafe()).toBeUndefined();

      expect((yield* service.resume(handle.runId)).state).toBe("running");
      backend.controls[0]!.report(handle.runId, 1, "after-pause", "Auth module reviewed.");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        kind: "completed",
        text: "Auth module reviewed.",
      });
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([]);
    });
  });

  it.effect("takes none of the root's direct-child slots while its workflow owns it", () => {
    const nestingPolicy = { maxDirectChildren: 2, maxDepth: 3 };
    const { layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      for (let index = 0; index < 3; index++)
        yield* service.startOwned(ownedRequest({ nestingPolicy }), owner);
      // The main agent's own starts still have every slot, and only they fill it.
      yield* service.start(nativeReportRequest({ name: "main-1", nestingPolicy }));
      yield* service.start(nativeReportRequest({ name: "main-2", nestingPolicy }));
      const full = yield* service
        .start(nativeReportRequest({ name: "main-3", nestingPolicy }))
        .pipe(Effect.flip);
      expect(errorCode(full)).toBe("direct_child_capacity");
    });
  });

  it.effect("counts an owned run without a workflow placement as an ordinary root child", () => {
    const nestingPolicy = { maxDirectChildren: 1, maxDepth: 3 };
    const { layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      yield* service.startOwned(ownedRequest({ nestingPolicy, workflow: undefined }), owner);
      const full = yield* service
        .start(nativeReportRequest({ name: "main", nestingPolicy }))
        .pipe(Effect.flip);
      expect(errorCode(full)).toBe("direct_child_capacity");
    });
  });

  it.effect("holds a workflow agent's own subagents to the depth and direct-child limits", () => {
    const nestingPolicy = { maxDirectChildren: 1, maxDepth: 2 };
    const { layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const agent = yield* service.startOwned(ownedRequest({ nestingPolicy }), owner);
      yield* service.start(nativeReportRequest({ name: "main", nestingPolicy }));
      const child = yield* service.startSessionOwnedFrom(
        agent.runId,
        nativeReportRequest({ name: "child", nestingPolicy }),
      );
      expect(child).toMatchObject({ parentRunId: agent.runId, depth: 2 });
      const sibling = yield* service
        .startSessionOwnedFrom(agent.runId, nativeReportRequest({ name: "sibling", nestingPolicy }))
        .pipe(Effect.flip);
      expect(errorCode(sibling)).toBe("direct_child_capacity");
      const grandchild = yield* service
        .startSessionOwnedFrom(child.id, nativeReportRequest({ name: "grandchild", nestingPolicy }))
        .pipe(Effect.flip);
      expect(errorCode(grandchild)).toBe("nesting_depth_limit");
    });
  });

  it.effect("counts a former workflow agent toward the root's limit once resumed", () => {
    const nestingPolicy = { maxDirectChildren: 1, maxDepth: 3 };
    const { backend, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({
        capabilities: ["steer", "interrupt", "resume", "rename-display", "parent-contact"],
        resumable: true,
      }),
      {},
      profileLayerFor({ version: 6, nesting: nestingPolicy }),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest(), owner);
      const main = yield* service.start(nativeReportRequest({ name: "main", nestingPolicy }));
      backend.controls[0]!.report(handle.runId, 1, "result", "Checked.");
      expect(yield* service.awaitOwned(handle)).toMatchObject({ kind: "completed" });
      yield* service.closeOwner(OWNER);
      // Handed back, it is an ordinary root child, so resuming it needs a free root slot.
      const refused = yield* service.resume(handle.runId, "Continue.").pipe(Effect.flip);
      expect(errorCode(refused)).toBe("direct_child_capacity");
      yield* service.stop(main.id);
      expect((yield* service.resume(handle.runId, "Continue.")).state).toBe("running");
    });
  });

  it.effect("isolates an owned writer in a worktree when its owner asks for one", () => {
    const fixture = nativeReportServiceFixture();
    const layer = fixture.layer.pipe(
      Layer.provide(Layer.succeed(WorkspaceService, createOnlyWorkspaceEngine())),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const writer = yield* service.startOwned(
        ownedRequest({
          name: "isolated-writer",
          writeIntent: "writer",
          writerWorkspaceModeOverride: "worktree",
        }),
        owner,
      );
      const run = (yield* service.list).find((candidate) => candidate.id === writer.runId);
      expect(run?.writerWorkspaceMode).toBe("worktree");
      expect(run?.workspaceId).toBeDefined();
    });
  });

  it.effect("rejects root operations that would detach a live owner's result", () => {
    const { backend, projections, layer } = nativeReportServiceFixture(parentContactBackend());
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const reported = yield* service.startOwned(ownedRequest(), owner);
      const failed = yield* service.startOwned(ownedRequest({ name: "will-fail" }), owner);

      const awaited = yield* awaitRuns(service, [reported.runId], "all_finished").pipe(Effect.flip);
      expect(errorCode(awaited)).toBe("workflow_owned_run");

      backend.controls[0]!.report(reported.runId, 1, "done", "Reported.");
      backend.controls[1]!.offer({ type: "protocol_error", message: "Malformed frame." });
      yield* yieldUntil(
        () =>
          stateOf(projections, reported.runId) === "completed" &&
          stateOf(projections, failed.runId) === "failed",
      );
      const resumed = yield* service.resume(reported.runId).pipe(Effect.flip);
      expect(errorCode(resumed)).toBe("workflow_owned_run");
      const retried = yield* service.claimRetryContinuation(failed.runId).pipe(Effect.flip);
      expect(errorCode(retried)).toBe("workflow_owned_run");

      yield* service.closeOwner(OWNER);
      const runs = yield* awaitRuns(service, [reported.runId, failed.runId], "all_finished");
      expect(runs.map((run) => run.state)).toEqual(["completed", "failed"]);
    });
  });

  it.effect("closes an owner by stopping live runs and handing back unread writer reports", () => {
    const { backend, projections, notifications, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const writer = yield* service.startOwned(
        ownedRequest({ name: "writer", writeIntent: "writer" }),
        owner,
      );
      const reader = yield* service.startOwned(ownedRequest({ name: "reader" }), owner);
      const running = yield* service.startOwned(ownedRequest({ name: "running" }), owner);
      backend.controls[0]!.report(writer.runId, 1, "writer", "Changed src/auth.ts.");
      backend.controls[1]!.report(reader.runId, 1, "reader", "Read-only findings.");
      yield* yieldUntil(
        () =>
          stateOf(projections, writer.runId) === "completed" &&
          stateOf(projections, reader.runId) === "completed",
      );

      yield* service.closeOwner(OWNER);
      expect(stateOf(projections, running.runId)).toBe("stopped");
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([writer.runId]);

      const late = yield* service
        .startOwned(ownedRequest({ name: "late" }), owner)
        .pipe(Effect.flip);
      expect(errorCode(late)).toBe("workflow_owner_closed");
      expect((yield* service.list).map((run) => run.name)).not.toContain("late");
    });
  });

  it.effect("stops the run and releases its report when an owned await is interrupted", () => {
    const { notifications, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest(), owner);
      const waiting = yield* service.awaitOwned(handle).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      expect(stateOf(projections, handle.runId)).toBe("stopped");
      const again = yield* service.awaitOwned(handle).pipe(Effect.flip);
      expect(errorCode(again)).toBe("owned_run_released");
      yield* drainDelivery;
      expect(notifications).toEqual([]);
    });
  });

  it.effect("releases owned runs whose start scope closes before they are awaited", () => {
    const { backend, projections, notifications, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const [writer, reader] = yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* service.startOwned(
            ownedRequest({ name: "writer", writeIntent: "writer" }),
            owner,
          );
          const reader = yield* service.startOwned(ownedRequest({ name: "reader" }), owner);
          backend.controls[0]!.report(writer.runId, 1, "writer", "Changed src/auth.ts.");
          yield* yieldUntil(() => stateOf(projections, writer.runId) === "completed");
          return [writer, reader] as const;
        }),
      );
      expect(stateOf(projections, reader.runId)).toBe("stopped");
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([writer.runId]);
    });
  });

  it.effect("stops an admitted run when its owned start is interrupted", () => {
    const startGate = Deferred.makeUnsafe<void>();
    const { backend, projections, notifications, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ initialStartGate: startGate }),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const runId = yield* service.reserveRunId;
      const starting = yield* service
        .startOwned(ownedRequest(), { ...owner, runId })
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.prompts.length === 1);
      // Request interruption while the prompt is in flight, then let the backend accept it.
      starting.interruptUnsafe();
      yield* Deferred.succeed(startGate, undefined);
      expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
      expect(stateOf(projections, runId)).toBe("stopped");
      expect(backend.controls[0]?.released()).toBe(1);
      yield* drainDelivery;
      expect(notifications).toEqual([]);
    });
  });

  it.effect("fails an owned start after admission without leaking its failure to the root", () => {
    const startGate = Deferred.makeUnsafe<void>();
    const { backend, projections, notifications, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ initialStartGate: startGate }),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const runId = yield* service.reserveRunId;
      const starting = yield* service
        .startOwned(ownedRequest(), { ...owner, runId })
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls[0]?.prompts.length === 1);
      backend.controls[0]!.failNextStart();
      yield* Deferred.succeed(startGate, undefined);
      const failure = yield* Fiber.join(starting).pipe(Effect.flip);
      expect(failure._tag).toBe("SubagentProcessError");
      expect(stateOf(projections, runId)).toBe("failed");
      const reused = yield* service
        .startOwned(ownedRequest(), { ...owner, runId })
        .pipe(Effect.flip);
      expect(errorCode(reused)).toBe("owned_run_id_unavailable");
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([]);
    });
  });

  it.effect("advances the admission revision only when a writer's hold is released", () => {
    const releaseGate = Deferred.makeUnsafe<void>();
    const { backend, projections, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ releaseGate }),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest({ writeIntent: "writer" }), owner);
      const before = yield* service.admissionRevision;
      const waiting = yield* service.waitForAdmissionChange(before).pipe(Effect.forkScoped);
      for (let output = 1; output <= 5; output++)
        backend.controls[0]!.offer({ type: "usage", usage: { ...emptyUsage(), output } });
      yield* yieldUntil(
        () => projections.at(-1)?.runs.find((run) => run.id === handle.runId)?.usage.output === 15,
      );
      backend.controls[0]!.report(handle.runId, 1, "done", "Done.");
      yield* yieldUntil(() => stateOf(projections, handle.runId) === "completed");
      // Progress and settlement leave the writer's hold in place until backend cleanup ends it.
      expect(yield* service.admissionRevision).toBe(before);
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseGate, undefined);
      yield* Fiber.join(waiting);
      expect(yield* service.admissionRevision).toBeGreaterThan(before);
    });
  });

  it.effect("resolves an owned run stopped while it starts as stopped", () => {
    const initializeGate = Deferred.makeUnsafe<void>();
    const { backend, projections, notifications, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({ initializeGate }),
    );
    return withService(layer, function* (service) {
      yield* service.openOwner(OWNER);
      const runId = yield* service.reserveRunId;
      const starting = yield* service
        .startOwned(ownedRequest(), { ...owner, runId })
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => backend.controls.length === 1);
      const stopping = yield* service.stop(runId).pipe(Effect.forkScoped);
      yield* yieldUntil(() => stateOf(projections, runId) === "stopped");
      yield* Deferred.succeed(initializeGate, undefined);
      const handle = yield* Fiber.join(starting);
      expect(yield* service.awaitOwned(handle)).toMatchObject({ kind: "stopped" });
      yield* Fiber.join(stopping);
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([]);
    });
  });

  it.effect("resumes a former workflow agent as an ordinary root child", () => {
    const { backend, projections, notifications, layer } = nativeReportServiceFixture(
      fakeNativeReportBackendLayer({
        capabilities: ["steer", "interrupt", "resume", "rename-display", "parent-contact"],
        resumable: true,
      }),
    );
    return withService(layer, function* (service) {
      const resultContract = yield* compileResultContract({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      });
      yield* service.openOwner(OWNER);
      const handle = yield* service.startOwned(ownedRequest({ resultContract }), owner);
      backend.controls[0]!.report(handle.runId, 1, "result", '{"ok":true}');
      expect(yield* service.awaitOwned(handle)).toMatchObject({ kind: "completed" });
      yield* service.closeOwner(OWNER);

      expect((yield* service.resume(handle.runId, "Explain what you checked.")).state).toBe(
        "running",
      );
      const resumed = backend.launches.at(-1)!;
      expect(resumed.resultContract).toBeUndefined();
      expect(resumed.systemPrompt).toBe(
        childSystemPrompt(nativeReportRequest({ name: "find-issues" })),
      );
      const control = backend.controls.at(-1)!;
      control.offer({
        type: "supervisor_contact",
        assignmentEpoch: 2,
        requestId: "question-after",
        kind: "question",
        message: "Which file?",
      });
      yield* yieldUntil(() => stateOf(projections, handle.runId) === "waiting_for_parent");
      yield* drainDelivery;
      expect(questions(notifications).at(-1)).toMatchObject({ id: handle.runId });
      expect(questions(notifications).at(-1)?.workflow).toBeUndefined();
      yield* service.reply(handle.runId, "src/auth.ts");
      control.report(handle.runId, 1, "prose", "I checked src/auth.ts.");
      yield* yieldUntil(() => stateOf(projections, handle.runId) === "completed");
      yield* drainDelivery;
      expect(rootOutcomes(notifications)).toEqual([handle.runId]);
    });
  });
});
