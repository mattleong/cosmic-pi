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
import {
  SubagentService,
  type SubagentServiceContract,
  type SubagentStatusObservationOptions,
} from "../../src/run/service.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  askParent,
  localServiceFixture,
  request,
  withService,
  awaitRuns,
} from "./fixtures/service-harness.ts";
import { InvalidSubagentRequestError, SubagentRuntimeClosedError } from "../../src/run/errors.ts";

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
        notification.runs.map((run) => `${run.id}:${run.generation}`),
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

const includeDeliveredReports: SubagentStatusObservationOptions = {
  includeDeliveredReports: true,
};

const observeStatus = (
  service: SubagentServiceContract,
  id: string,
  options?: SubagentStatusObservationOptions,
) =>
  service.withStatusObservations(
    [id],
    ({ observations }) => Effect.succeed(observations[0]),
    options,
  );

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
      const delivered = yield* service.status(run.id);
      expect(delivered.reportStatus).toBe("delivered");
      expect(delivered.finalText).toBeUndefined();
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

  it.effect("redacts an await-owned report from default and opt-in status", () => {
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

      const expectRedacted = Effect.gen(function* () {
        const competingStatus = yield* service.status(run.id);
        expect(competingStatus).not.toHaveProperty("finalText");
        expect(competingStatus.sessionEvents).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ text: "Owned report text." })]),
        );
        const competing = yield* observeStatus(service, run.id, includeDeliveredReports);
        expect(competing).not.toHaveProperty("completionReceipt");
        expect(competing?.run.reportStatus).toBe("claimed");
        expect(competing?.run).not.toHaveProperty("finalText");
      });
      yield* expectRedacted;
      yield* service.consumeCompletions([
        { id: run.id, generation: 1, claimToken: "forged-owner" },
      ]);
      yield* expectRedacted;

      yield* Deferred.succeed(releaseRender, undefined);
      const observations = yield* Fiber.join(awaiting);
      expect(observations[0]?.run.finalText).toBe("Owned report text.");
      expect((yield* observeStatus(service, run.id, includeDeliveredReports))?.run).toMatchObject({
        reportStatus: "delivered",
        finalText: "Owned report text.",
      });
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
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

  it.effect("returns an offender's await once it stops while its peer keeps working", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const offender = yield* service.start(
        request({ name: "pool-offender", writeIntent: "writer", writes: ["src/a.ts"] }),
      );
      const peer = yield* service.start(
        request({ name: "awaited-pool-peer", writeIntent: "writer", writes: ["src/b.ts"] }),
      );
      const offenderAwait = yield* awaitRuns(service, [offender.id], "all_finished").pipe(
        Effect.forkScoped,
      );
      const peerAwait = yield* awaitRuns(service, [peer.id], "all_finished").pipe(
        Effect.forkScoped,
      );

      fake.controls[0]?.offer({
        type: "tool_execution_start",
        toolCallId: "pool-violation",
        toolName: "edit",
        args: { path: "src/c.ts", edits: [] },
      });
      expect(yield* Fiber.join(offenderAwait)).toMatchObject([
        { id: offender.id, state: "stopped", writeViolationOffender: true },
      ]);
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
      expect(completed.map((run) => run.state)).toEqual(["completed", "completed"]);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      expect(updates.at(-1)?.every((run) => run.state === "completed")).toBe(true);
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
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect(
        notifications.filter((notification) => notification.type === "completed"),
      ).toHaveLength(1);
    });
  });
});
