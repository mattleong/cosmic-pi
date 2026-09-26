// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  contactParentFrame,
  expectInterruptBeforeUse,
  localServiceFixture,
  request,
  useProbe,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";

type CompletionPolicy = (
  attempt: number,
  keys: ReadonlyArray<string>,
) => { readonly deliveredCompletionKeys: ReadonlyArray<string> };

const unacknowledged: CompletionPolicy = () => ({ deliveredCompletionKeys: [] });

/** One local run whose completed notifications go through `policy`, counting each attempt. */
const completionRetryFixture = (policy: CompletionPolicy) => {
  let attempts = 0;
  const { fake, projections, notifications, layer } = localServiceFixture({
    notify: (notification) => {
      if (notification.type !== "completed") return undefined;
      attempts += 1;
      return policy(
        attempts,
        notification.runs.map((run) => `${run.id}:${run.generation}`),
      );
    },
  });
  /** Starts and completes the run, then waits for its first delivery attempt. */
  const firstAttempt = (service: SubagentServiceContract) =>
    Effect.gen(function* () {
      const run = yield* service.start(request({ name: "completion-retry" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => attempts === 1);
      return run;
    });
  return { notifications, layer, attempts: () => attempts, firstAttempt };
};

describe("SubagentService", () => {
  for (const operation of ["await", "status"] as const)
    it.effect(`preserves the caller resource scope through ${operation} observations`, () => {
      const { layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request());
        yield* service.stop(run.id);
        let released = false;
        const use = () =>
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
        yield* Effect.gen(function* () {
          if (operation === "await")
            yield* service.withAwaitTerminalObservations([run.id], "all_finished", undefined, use);
          else yield* service.withStatusObservations([run.id], use);
          expect(released).toBe(false);
        }).pipe(Effect.scoped);
        expect(released).toBe(true);
      });
    });

  for (const operation of ["await", "status"] as const)
    it.effect(
      `cancels ${operation} before claim ownership while ancestor delivery holds the gate`,
      () => {
        const { fake, layer } = localServiceFixture();
        return withService(layer, function* (service) {
          const parent = yield* service.start(request());
          const child = yield* service.startSessionOwnedFrom(parent.id, request());
          const gate = yield* Deferred.make<void>();
          fake.controls[0]!.gateNextIpcType("proxy_notification", gate);
          fake.controls[1]!.settle("Child report.");
          yield* waitForCompleted(service, child.id);
          yield* TestClock.adjust("100 millis");
          yield* yieldUntil(() => fake.controls[0]!.sentIpc("proxy_notification"));
          const probe = useProbe();
          const waiter = yield* (
            operation === "await"
              ? service.withAwaitTerminalObservations(
                  [parent.id],
                  "all_finished",
                  undefined,
                  probe.use,
                )
              : service.withStatusObservations([parent.id], probe.use)
          ).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* expectInterruptBeforeUse(waiter, probe, gate);
          let observed = false;
          const replacement = yield* service
            .withAwaitTerminalObservations(
              [parent.id],
              "all_finished",
              () => {
                observed = true;
              },
              () => Effect.void,
            )
            .pipe(Effect.forkScoped);
          yield* yieldUntil(() => observed);
          yield* Fiber.interrupt(replacement);
        });
      },
    );

  it.effect("rejects parallel await ownership and releases only the cancelled claim", () => {
    const { fake, notifications, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "exclusive-await" }));
      const enteredRender = yield* Deferred.make<void>();
      const first = yield* service
        .withAwaitTerminalObservations(
          [run.id],
          "all_finished",
          (runs) => updates.push(runs),
          () => Deferred.succeed(enteredRender, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[0]?.settle("Exclusively delivered.");
      yield* Deferred.await(enteredRender);
      const competing = yield* service.status(run.id);
      expect(competing.reportStatus).toBe("claimed");
      expect(competing.finalText).toBeUndefined();
      expect(updates.at(-1)?.[0]?.reportStatus).toBe("available");

      const conflict = yield* service.awaitTerminal([run.id], "all_finished").pipe(Effect.flip);
      expect(conflict).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "completion_claim_conflict",
      });

      yield* Fiber.interrupt(first);
      const replacement = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);
      expect(yield* Fiber.join(replacement)).toMatchObject([
        { state: "completed", finalText: "Exclusively delivered.", reportStatus: "available" },
      ]);
      const delivered = yield* service.status(run.id);
      expect(delivered.reportStatus).toBe("delivered");
      expect(delivered.finalText).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect(
    "does not miss a publication triggered between the locked check and subscription",
    () => {
      const { fake, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "revision-race" }));
        let triggered = false;
        const [completed] = yield* service.awaitTerminal([run.id], "all_finished", () => {
          if (triggered) return;
          triggered = true;
          fake.controls[0]?.settle("Completed during subscription setup.");
        });
        expect(triggered).toBe(true);
        expect(completed).toMatchObject({
          id: run.id,
          state: "completed",
          finalText: "Completed during subscription setup.",
        });
      });
    },
  );

  it.effect("supplies descendant projection context with await updates", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "await-parent" }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "await-child" }),
      );
      let updateProjection: SubagentProjection["runs"] | undefined;
      let settled = false;
      const completed = yield* service.awaitTerminal(
        [parent.id],
        "all_finished",
        (_runs, projection) => {
          updateProjection = projection;
          if (!settled) {
            settled = true;
            fake.controls[0]?.settle();
          }
        },
      );
      expect(completed[0]?.state).toBe("completed");
      expect(updateProjection?.map((run) => run.id)).toEqual(
        expect.arrayContaining([parent.id, child.id]),
      );
      yield* service.stop(child.id);
    });
  });

  it.effect(
    "wakes multiple subscribers across consecutive non-terminal and terminal revisions",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const first = yield* service.start(request({ name: "revision-first" }));
        const second = yield* service.start(request({ name: "revision-second" }));
        let firstUpdates = 0;
        let secondUpdates = 0;
        const firstAwait = yield* service
          .awaitTerminal([first.id], "all_finished", () => firstUpdates++)
          .pipe(Effect.forkScoped);
        const secondAwait = yield* service
          .awaitTerminal([second.id], "all_finished", () => secondUpdates++)
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => firstUpdates > 0 && secondUpdates > 0);

        yield* service.rename(first.id, "revision-first-renamed");
        yield* yieldUntil(() => firstUpdates > 1 && secondUpdates > 1);
        fake.controls[0]?.settle();
        expect((yield* Fiber.join(firstAwait))[0]?.state).toBe("completed");
        expect(secondAwait.pollUnsafe()).toBeUndefined();

        fake.controls[1]?.settle();
        expect((yield* Fiber.join(secondAwait))[0]?.state).toBe("completed");

        const finalProjection = yield* service.projection;
        expect(projections.map((projection) => projection.revision)).toEqual(
          Array.from({ length: projections.length }, (_, index) => index + 1),
        );
        expect(finalProjection).toEqual(projections.at(-1));
      });
    },
  );

  it.effect("fails subscribed awaits when the service scope closes", () => {
    const { layer } = localServiceFixture();
    return Effect.gen(function* () {
      const serviceScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, serviceScope);
      const service = Context.get(context, SubagentService);
      const run = yield* service.start(request({ name: "revision-shutdown" }));
      let updates = 0;
      const waiting = yield* service
        .awaitTerminal([run.id], "all_finished", () => updates++)
        .pipe(Effect.result, Effect.forkScoped);
      yield* yieldUntil(() => updates > 0);

      yield* Scope.close(serviceScope, Exit.void);
      const result = yield* Fiber.join(waiting);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SubagentRuntimeClosedError" },
      });
    }).pipe(Effect.scoped);
  });

  it.effect("redacts a completed report from status while an await owns its receipt", () => {
    const { fake, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "await-status-race" }));
      const entered = yield* Deferred.make<void>();
      const releaseRender = yield* Deferred.make<void>();
      const awaiting = yield* service
        .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(releaseRender);
            const receipt = observations[0]?.completionReceipt;
            if (receipt) yield* service.consumeCompletions([receipt]);
            return observations;
          }),
        )
        .pipe(Effect.forkScoped);

      fake.controls[0]?.settle("Owned report text.");
      yield* Deferred.await(entered);

      const competingObservation = yield* service.withStatusObservations(
        [run.id],
        ({ observations }) => Effect.succeed(observations[0]),
      );
      expect(competingObservation).not.toHaveProperty("completionReceipt");
      const competingStatus = yield* service.status(run.id);
      expect(competingStatus).not.toHaveProperty("finalText");
      expect(competingStatus.sessionEvents).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ text: "Owned report text." })]),
      );
      yield* service.consumeCompletions([
        { id: run.id, generation: 1, claimToken: "forged-owner" },
      ]);
      expect(yield* service.status(run.id)).not.toHaveProperty("finalText");

      yield* Deferred.succeed(releaseRender, undefined);
      const observations = yield* Fiber.join(awaiting);
      expect(observations[0]?.run.finalText).toBe("Owned report text.");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect("returns an await when a selected run needs a parent reply", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "awaiting-question" }));
      const awaiting = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);

      fake.controls[0]?.offerIpc(
        contactParentFrame("question-during-await", "question", "Should I update the fixture?"),
      );
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "waiting_for_parent");

      const [attention] = yield* Fiber.join(awaiting);
      expect(attention).toMatchObject({
        id: run.id,
        state: "waiting_for_parent",
        question: { requestId: "question-during-await" },
      });
    });
  });

  it.effect("returns an await when a selected run is paused", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "awaiting-pause" }));
      const awaiting = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);

      yield* service.interrupt(run.id);
      expect(yield* Fiber.join(awaiting)).toMatchObject([{ id: run.id, state: "paused" }]);
    });
  });

  it.effect("waits for an offending writer to pause but returns an admission-paused peer", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const offender = yield* service.start(
        request({ name: "pool-offender", writeIntent: "writer", writes: ["src/a.ts"] }),
      );
      const peer = yield* service.start(
        request({ name: "awaited-pool-peer", writeIntent: "writer", writes: ["src/b.ts"] }),
      );
      const interruptGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextSend("abort", interruptGate);
      const offenderAwait = yield* service
        .awaitTerminal([offender.id], "all_finished")
        .pipe(Effect.forkScoped);
      const peerAwait = yield* service
        .awaitTerminal([peer.id], "all_finished")
        .pipe(Effect.forkScoped);

      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "pool-violation",
        toolName: "edit",
        args: { path: "src/c.ts", edits: [] },
      });
      yield* yieldUntil(
        () =>
          projections.at(-1)?.runs.find((candidate) => candidate.id === offender.id)
            ?.writeViolationOffender === true,
      );

      expect(offenderAwait.pollUnsafe()).toBeUndefined();
      expect(yield* Fiber.join(peerAwait)).toMatchObject([
        { id: peer.id, state: "running", writeAdmissionPaused: true },
      ]);

      yield* Deferred.succeed(interruptGate, undefined);
      expect(yield* Fiber.join(offenderAwait)).toMatchObject([
        {
          id: offender.id,
          state: "paused",
          writeAdmissionPaused: true,
          writeViolationOffender: true,
        },
      ]);
    });
  });

  it.effect("reports every missing await ID before waiting", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const failure = yield* Effect.flip(
        service.awaitTerminal(["agent-missing-1", "agent-missing-2"], "all_finished"),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "subagent_runs_not_found",
      });
      expect(failure.message).toContain("agent-missing-1, agent-missing-2");
      expect(failure.message).toContain("subagent_list");
    });
  });

  it.effect("delivers a claimed failure through await without a background notification", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();

    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "awaited-failure" }));
      const awaiting = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      fake.controls[0]?.exit(1);
      const [failed] = yield* Fiber.join(awaiting);
      expect(failed).toMatchObject({ id: run.id, state: "failed", error: expect.any(String) });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "failed");
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect("awaits a fleet without polling and consumes its completion notifications", () => {
    const { fake, notifications, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const first = yield* service.start(request({ name: "await-one" }));
      const second = yield* service.start(request({ name: "await-two" }));
      const waiting = yield* service
        .awaitTerminal([first.id, second.id], "all_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);

      fake.controls[0]?.settle();
      yield* yieldUntil(() => updates.at(-1)?.[0]?.state === "completed");
      expect(updates.at(-1)?.[1]?.state).toBe("running");
      fake.controls[1]?.settle();

      const completed = yield* Fiber.join(waiting);
      expect(completed.map((run) => run.state)).toEqual(["completed", "completed"]);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      expect(updates.at(-1)?.every((run) => run.state === "completed")).toBe(true);
    });
  });

  it.effect("rejects empty awaits at the service boundary", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      for (const until of ["all_finished", "any_finished"] as const) {
        const error = yield* Effect.flip(service.awaitTerminal([], until));
        expect(error._tag).toBe("InvalidSubagentRequestError");
      }
    });
  });

  it.effect("supports any-terminal awaits without consuming running peers", () => {
    const { fake, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const first = yield* service.start(request({ name: "any-one" }));
      const second = yield* service.start(request({ name: "any-two" }));
      const waiting = yield* service
        .awaitTerminal([first.id, second.id], "any_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[1]?.settle();
      const runs = yield* Fiber.join(waiting);
      expect(runs.map((run) => run.state)).toEqual(["running", "completed"]);
    });
  });

  it.effect("releases await claims when the waiting fiber is interrupted", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "cancelled-await" }));
      const waiting = yield* service
        .awaitTerminal([run.id], "all_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      yield* Fiber.interrupt(waiting);
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id }],
      });
    });
  });

  it.effect("keeps unconsumed observations notification-eligible", () => {
    const { fake, notifications, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "observed-report" }));
      const waiting = yield* service
        .withAwaitTerminalObservations(
          [run.id],
          "all_finished",
          (runs) => updates.push(runs),
          Effect.succeed,
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[0]?.settle();
      const observations = yield* Fiber.join(waiting);
      expect(observations[0]?.completionReceipt).toEqual({
        id: run.id,
        generation: 1,
        claimToken: expect.any(String),
      });
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
    });
  });

  it.effect("returns found status observations alongside every stale ID", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "status-selection" }));

      const selection = yield* service.withStatusObservations(
        [run.id, "agent-stale-1", "agent-stale-2"],
        Effect.succeed,
      );

      expect(selection.observations.map((observation) => observation.run.id)).toEqual([run.id]);
      expect(selection.missingIds).toEqual(["agent-stale-1", "agent-stale-2"]);
    });
  });

  it.effect("holds a completion claim through observation formatting and consumption", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "leased-observation" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const acquired = yield* Deferred.make<void>();
      const releaseUse = yield* Deferred.make<void>();
      const observing = yield* service
        .withStatusObservations([run.id], ({ observations }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(releaseUse);
            const receipt = observations[0]?.completionReceipt;
            if (receipt) yield* service.consumeCompletions([receipt]);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      yield* Deferred.succeed(releaseUse, undefined);
      yield* Fiber.join(observing);
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect("coalesces unclaimed fleet completions into one notification", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(request({ name: "notify-one" }));
      const second = yield* service.start(request({ name: "notify-two" }));
      fake.controls[0]?.settle();
      fake.controls[1]?.settle();
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs.every((run) => run.state === "completed")),
      );
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);

      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [
          { id: first.id, name: "notify-one", generation: 1 },
          { id: second.id, name: "notify-two", generation: 1 },
        ],
      });
    });
  });

  for (const [failure, policy] of [
    [
      "an unacknowledged",
      (attempt, keys) => ({ deliveredCompletionKeys: attempt === 1 ? [] : keys }),
    ],
    [
      "a throwing",
      (attempt, keys) => {
        if (attempt === 1) throw new Error("completed delivery boundary failure");
        return { deliveredCompletionKeys: keys };
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, CompletionPolicy]>)
    it.effect(`redelivers a completion once after ${failure} first attempt`, () => {
      const { notifications, layer, attempts, firstAttempt } = completionRetryFixture(policy);
      return withService(layer, function* (service) {
        yield* firstAttempt(service);
        yield* TestClock.adjust("200 millis");
        yield* yieldUntil(() => attempts() === 2);
        yield* TestClock.adjust("30 seconds");
        expect(attempts()).toBe(2);
        expect(notifications).toHaveLength(2);
      });
    });

  it.effect("caps persistent completion retry backoff at thirty seconds", () => {
    const { layer, attempts, firstAttempt } = completionRetryFixture(unacknowledged);
    return withService(layer, function* (service) {
      yield* firstAttempt(service);
      for (const [index, delay] of [
        200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000,
      ].entries()) {
        yield* TestClock.adjust(`${delay} millis`);
        yield* yieldUntil(() => attempts() === index + 2);
      }
      expect(attempts()).toBe(11);
    });
  });

  it.effect("re-delivers only the unacknowledged half of a partially delivered batch", () => {
    const batches: Array<ReadonlyArray<{ id: string; generation: number }>> = [];
    const { fake, projections, layer } = localServiceFixture({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        batches.push(notification.runs.map(({ id, generation }) => ({ id, generation })));
        const first = notification.runs[0];
        return { deliveredCompletionKeys: first ? [`${first.id}:${first.generation}`] : [] };
      },
    });
    return withService(layer, function* (service) {
      const one = yield* service.start(request({ name: "partial-one" }));
      const two = yield* service.start(request({ name: "partial-two" }));
      fake.controls[0]?.settle();
      fake.controls[1]?.settle();
      yield* yieldUntil(() =>
        Boolean(projections.at(-1)?.runs.every((run) => run.state === "completed")),
      );
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 1);
      expect(batches[0]).toEqual([
        { id: one.id, generation: 1 },
        { id: two.id, generation: 1 },
      ]);

      // A partial acknowledgment resets the retry delay to its initial value and
      // retains only the unacknowledged completion for the next attempt.
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 2);
      expect(batches[1]).toEqual([{ id: two.id, generation: 1 }]);
      yield* TestClock.adjust("30 seconds");
      expect(batches).toHaveLength(2);
    });
  });

  it.effect("claiming a queued completion retry removes it from delivery ownership", () => {
    const { layer, attempts, firstAttempt } = completionRetryFixture(unacknowledged);
    return withService(layer, function* (service) {
      const run = yield* firstAttempt(service);
      // The await claim is serialized against delivery and removes the queued retry.
      const runs = yield* service.awaitTerminal([run.id], "all_finished");
      expect(runs[0]?.state).toBe("completed");
      yield* TestClock.adjust("60 seconds");
      expect(attempts()).toBe(1);
    });
  });

  it.effect("stops pending completion retries when the session scope closes", () => {
    const { layer, attempts, firstAttempt } = completionRetryFixture(unacknowledged);
    return Effect.gen(function* () {
      yield* withService(layer, function* (service) {
        yield* firstAttempt(service);
      });
      // The retry fiber is owner-scoped: closing the session scope ends redelivery.
      yield* TestClock.adjust("60 seconds");
      expect(attempts()).toBe(1);
    });
  });

  it.effect("emits only one completion for repeated terminal events", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "single-settlement" }));
      fake.controls[0]?.settle();
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length > 0);
      yield* Effect.yieldNow;
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect(
        notifications.filter((notification) => notification.type === "completed"),
      ).toHaveLength(1);
    });
  });
});
