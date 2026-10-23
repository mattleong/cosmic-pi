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
  askParent,
  awaitRuns,
  localServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";
import { InvalidSubagentRequestError, SubagentRuntimeClosedError } from "../../src/run/errors.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

type CompletionPolicy = (
  attempt: number,
  keys: ReadonlyArray<string>,
) => { readonly deliveredCompletionKeys: ReadonlyArray<string> };

const unacknowledged: CompletionPolicy = () => ({ deliveredCompletionKeys: [] });

const completionRetryFixture = (policy: CompletionPolicy) => {
  let attempts = 0;
  const { fake, projections, notifications, layer } = localServiceFixture({
    notify: (notification) => {
      if (notification.type !== "completed") return undefined;
      attempts += 1;
      return policy(
        attempts,
        Arr.map(notification.runs, (run) => `${run.id}:${run.generation}`),
      );
    },
  });
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
  it.effect("preserves the caller resource scope through await observations", () => {
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
        yield* service.withAwaitTerminalObservations([run.id], "all_finished", undefined, use);
        expect(released).toBe(false);
      }).pipe(Effect.scoped);
      expect(released).toBe(true);
    });
  });

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
      expect(updates.at(-1)?.[0]?.reportStatus).toBe("available");

      const conflict = yield* awaitRuns(service, [run.id], "all_finished").pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(InvalidSubagentRequestError);
      expect(conflict).toMatchObject({ code: "completion_claim_conflict" });

      yield* Fiber.interrupt(first);
      const replacement = yield* awaitRuns(service, [run.id], "all_finished").pipe(
        Effect.forkScoped,
      );
      expect(yield* Fiber.join(replacement)).toMatchObject([
        { state: "completed", finalText: "Exclusively delivered.", reportStatus: "available" },
      ]);
      const [delivered] = yield* awaitRuns(service, [run.id], "all_finished");
      expect(delivered?.reportStatus).toBe("delivered");
      expect(delivered?.finalText).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    });
  });

  it.effect("fails subscribed awaits when the service scope closes", () => {
    const { layer } = localServiceFixture();
    return Effect.gen(function* () {
      const serviceScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, serviceScope);
      const service = Context.get(context, SubagentService);
      const run = yield* service.start(request({ name: "revision-shutdown" }));
      let updates = 0;
      const waiting = yield* awaitRuns(service, [run.id], "all_finished", () => updates++).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* yieldUntil(() => updates > 0);

      yield* Scope.close(serviceScope, Exit.void);
      expect(yield* Fiber.join(waiting)).toBeInstanceOf(SubagentRuntimeClosedError);
    }).pipe(Effect.scoped);
  });

  it.effect("consumes an await-owned report only with that await's claim", () => {
    const { fake, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "await-claim-owner" }));
      const entered = yield* Deferred.make<void>();
      const awaiting = yield* service
        .withAwaitTerminalObservations([run.id], "all_finished", undefined, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkScoped);

      fake.controls[0]?.settle("Owned report text.");
      yield* Deferred.await(entered);
      yield* service.consumeCompletions([
        { id: run.id, generation: 1, claimToken: "forged-owner" },
      ]);
      // Released unconsumed, the report still reaches the parent.
      yield* Fiber.interrupt(awaiting);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id, finalText: "Owned report text." }],
      });
    });
  });

  it.effect("returns an await when a selected run needs a parent reply", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "awaiting-question" }));
      const awaiting = yield* awaitRuns(service, [run.id], "all_finished").pipe(Effect.forkScoped);
      yield* askParent(fake.controls[0]!, projections, "question-during-await");

      const [attention] = yield* Fiber.join(awaiting);
      expect(attention).toMatchObject({
        id: run.id,
        state: "waiting_for_parent",
        question: { requestId: "question-during-await" },
      });
    });
  });

  it.effect("returns a pool writer's await once it stops while its peer keeps working", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const stopped = yield* service.start(
        request({ name: "pool-stopped", writeIntent: "writer" }),
      );
      const peer = yield* service.start(
        request({ name: "awaited-pool-peer", writeIntent: "writer" }),
      );
      const stoppedAwait = yield* awaitRuns(service, [stopped.id], "all_finished").pipe(
        Effect.forkScoped,
      );
      const peerAwait = yield* awaitRuns(service, [peer.id], "all_finished").pipe(
        Effect.forkScoped,
      );

      yield* service.stop(stopped.id);
      expect(yield* Fiber.join(stoppedAwait)).toMatchObject([{ id: stopped.id, state: "stopped" }]);
      expect(peerAwait.pollUnsafe()).toBeUndefined();

      fake.controls[1]?.settle();
      expect(yield* Fiber.join(peerAwait)).toMatchObject([{ id: peer.id, state: "completed" }]);
    });
  });

  it.effect("awaits a fleet without polling and consumes its completion notifications", () => {
    const { fake, notifications, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const first = yield* service.start(request({ name: "await-one" }));
      const second = yield* service.start(request({ name: "await-two" }));
      const waiting = yield* awaitRuns(service, [first.id, second.id], "all_finished", (runs) =>
        updates.push(runs),
      ).pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);

      fake.controls[0]?.settle();
      yield* yieldUntil(() => updates.at(-1)?.[0]?.state === "completed");
      expect(updates.at(-1)?.[1]?.state).toBe("running");
      fake.controls[1]?.settle();

      const completed = yield* Fiber.join(waiting);
      expect(Arr.map(completed, (run) => run.state)).toEqual(["completed", "completed"]);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      expect(
        Option.exists(Arr.last(updates), (runs) =>
          Arr.every(runs, (run) => run.state === "completed"),
        ),
      ).toBe(true);
    });
  });

  it.effect("releases await claims when the waiting fiber is interrupted", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    const updates: SubagentProjection["runs"][] = [];
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "cancelled-await" }));
      const waiting = yield* awaitRuns(service, [run.id], "all_finished", (runs) =>
        updates.push(runs),
      ).pipe(Effect.forkScoped);
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

  it.effect("holds a completion claim through observation formatting and consumption", () => {
    const { fake, projections, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "leased-observation" }));
      fake.controls[0]?.settle();
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      const acquired = yield* Deferred.make<void>();
      const releaseUse = yield* Deferred.make<void>();
      const observing = yield* service
        .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
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

  it.effect("re-delivers only the unacknowledged half of a partially delivered batch", () => {
    const batches: Array<ReadonlyArray<{ id: string; generation: number }>> = [];
    const { fake, projections, layer } = localServiceFixture({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        batches.push(Arr.map(notification.runs, ({ id, generation }) => ({ id, generation })));
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
        Option.exists(Arr.last(projections), (projection) =>
          Arr.every(projection.runs, (run) => run.state === "completed"),
        ),
      );
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 1);
      expect(batches[0]).toEqual([
        { id: one.id, generation: 1 },
        { id: two.id, generation: 1 },
      ]);

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => batches.length === 2);
      expect(batches[1]).toEqual([{ id: two.id, generation: 1 }]);
      yield* TestClock.adjust("30 seconds");
      expect(batches).toHaveLength(2);
    });
  });

  it.effect("stops pending completion retries when the session scope closes", () => {
    const { layer, attempts, firstAttempt } = completionRetryFixture(unacknowledged);
    return Effect.gen(function* () {
      yield* withService(layer, function* (service) {
        yield* firstAttempt(service);
      });
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
      expect((yield* runView(service, run.id)).state).toBe("completed");
      expect(
        Arr.filter(notifications, (notification) => notification.type === "completed"),
      ).toHaveLength(1);
    });
  });
});
