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
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  fakeChildLayer,
  request,
  serviceLayer,
  contactParentFrame,
  localServiceFixture,
} from "./fixtures/service-harness.ts";

describe("SubagentService", () => {
  it.effect("rejects parallel await ownership and releases only the cancelled claim", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer({
      notify: (notification) => void notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Exclusively delivered." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* Deferred.await(enteredRender);

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
        { state: "completed", finalText: "Exclusively delivered." },
      ]);
      yield* TestClock.adjust("1 second");
      expect(notifications).toEqual([]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "does not miss a publication triggered between the locked check and subscription",
    () => {
      const { fake, layer } = localServiceFixture();
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ name: "revision-race" }));
        let triggered = false;
        const [completed] = yield* service.awaitTerminal([run.id], "all_finished", () => {
          if (triggered) return;
          triggered = true;
          fake.controls[0]?.offer({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Completed during subscription setup." }],
            },
          });
          fake.controls[0]?.offer({ type: "agent_settled" });
        });
        expect(triggered).toBe(true);
        expect(completed).toMatchObject({
          id: run.id,
          state: "completed",
          finalText: "Completed during subscription setup.",
        });
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("supplies descendant projection context with await updates", () => {
    const { fake, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
            fake.controls[0]?.offer({ type: "agent_settled" });
          }
        },
      );
      expect(completed[0]?.state).toBe("completed");
      expect(updateProjection?.map((run) => run.id)).toEqual(
        expect.arrayContaining([parent.id, child.id]),
      );
      yield* service.stop(child.id);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "wakes multiple subscribers across consecutive non-terminal and terminal revisions",
    () => {
      const { fake, projections, layer } = localServiceFixture();
      return Effect.gen(function* () {
        const service = yield* SubagentService;
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
        fake.controls[0]?.offer({ type: "agent_settled" });
        expect((yield* Fiber.join(firstAwait))[0]?.state).toBe("completed");
        expect(secondAwait.pollUnsafe()).toBeUndefined();

        fake.controls[1]?.offer({ type: "agent_settled" });
        expect((yield* Fiber.join(secondAwait))[0]?.state).toBe("completed");

        const finalProjection = yield* service.projection;
        expect(projections.map((projection) => projection.revision)).toEqual(
          Array.from({ length: projections.length }, (_, index) => index + 1),
        );
        expect(finalProjection).toEqual(projections.at(-1));
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
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
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => void notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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

      fake.controls[0]?.offer({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Owned report text." }],
        },
      });
      fake.controls[0]?.offer({ type: "agent_settled" });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("returns an await when a selected run needs a parent reply", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("returns an await when a selected run is paused", () => {
    const { layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "awaiting-pause" }));
      const awaiting = yield* service
        .awaitTerminal([run.id], "all_finished")
        .pipe(Effect.forkScoped);

      yield* service.interrupt(run.id);
      expect(yield* Fiber.join(awaiting)).toMatchObject([{ id: run.id, state: "paused" }]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("waits for an offending writer to pause but returns an admission-paused peer", () => {
    const { fake, projections, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("reports every missing await ID before waiting", () => {
    const { layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const failure = yield* Effect.flip(
        service.awaitTerminal(["agent-missing-1", "agent-missing-2"], "all_finished"),
      );
      expect(failure).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "subagent_runs_not_found",
      });
      expect(failure.message).toContain("agent-missing-1, agent-missing-2");
      expect(failure.message).toContain("subagent_list");
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("delivers a claimed failure through await without a background notification", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );

    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("awaits a fleet without polling and consumes its completion notifications", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "await-one" }));
      const second = yield* service.start(request({ name: "await-two" }));
      const waiting = yield* service
        .awaitTerminal([first.id, second.id], "all_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);

      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => updates.at(-1)?.[0]?.state === "completed");
      expect(updates.at(-1)?.[1]?.state).toBe("running");
      fake.controls[1]?.offer({ type: "agent_settled" });

      const completed = yield* Fiber.join(waiting);
      expect(completed.map((run) => run.state)).toEqual(["completed", "completed"]);
      yield* TestClock.adjust("100 millis");
      expect(notifications).toEqual([]);
      expect(updates.at(-1)?.every((run) => run.state === "completed")).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("rejects empty awaits at the service boundary", () => {
    const { layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      for (const until of ["all_finished", "any_finished"] as const) {
        const error = yield* Effect.flip(service.awaitTerminal([], until));
        expect(error._tag).toBe("InvalidSubagentRequestError");
      }
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("supports any-terminal awaits without consuming running peers", () => {
    const fake = fakeChildLayer();
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer().pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "any-one" }));
      const second = yield* service.start(request({ name: "any-two" }));
      const waiting = yield* service
        .awaitTerminal([first.id, second.id], "any_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      fake.controls[1]?.offer({ type: "agent_settled" });
      const runs = yield* Fiber.join(waiting);
      expect(runs.map((run) => run.state)).toEqual(["running", "completed"]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("releases await claims when the waiting fiber is interrupted", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "cancelled-await" }));
      const waiting = yield* service
        .awaitTerminal([run.id], "all_finished", (runs) => updates.push(runs))
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => updates.length > 0);
      yield* Fiber.interrupt(waiting);
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: run.id }],
      });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("keeps unconsumed observations notification-eligible", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const updates: SubagentProjection["runs"][] = [];
    const layer = serviceLayer({
      notify: (notification) => notifications.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
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
      fake.controls[0]?.offer({ type: "agent_settled" });
      const observations = yield* Fiber.join(waiting);
      expect(observations[0]?.completionReceipt).toEqual({
        id: run.id,
        generation: 1,
        claimToken: expect.any(String),
      });
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("returns found status observations alongside every stale ID", () => {
    const { layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "status-selection" }));

      const selection = yield* service.withStatusObservations(
        [run.id, "agent-stale-1", "agent-stale-2"],
        Effect.succeed,
      );

      expect(selection.observations.map((observation) => observation.run.id)).toEqual([run.id]);
      expect(selection.missingIds).toEqual(["agent-stale-1", "agent-stale-2"]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("holds a completion claim through observation formatting and consumption", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "leased-observation" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("coalesces unclaimed fleet completions into one notification", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const first = yield* service.start(request({ name: "notify-one" }));
      const second = yield* service.start(request({ name: "notify-two" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[1]?.offer({ type: "agent_settled" });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("retries an unacknowledged completion generation", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        notifications.push(notification);
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        return {
          deliveredCompletionKeys:
            attempts === 1 ? [] : notification.runs.map((run) => `${run.id}:${run.generation}`),
        };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "retry-notification" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => attempts === 1);
      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => attempts === 2);
      yield* TestClock.adjust("500 millis");
      expect(attempts).toBe(2);
      expect(notifications).toHaveLength(2);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("redelivers a completion after the completed-notification callback throws", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        if (attempts === 1) throw new Error("completed delivery boundary failure");
        return {
          deliveredCompletionKeys: notification.runs.map((run) => `${run.id}:${run.generation}`),
        };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "throwing-completion" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => attempts === 1);
      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => attempts === 2);
      yield* TestClock.adjust("30 seconds");
      expect(attempts).toBe(2);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("caps persistent completion retry backoff at thirty seconds", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        return { deliveredCompletionKeys: [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      yield* service.start(request({ name: "persistent-retry" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      for (const [index, delay] of [
        100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000,
      ].entries()) {
        yield* TestClock.adjust(`${delay} millis`);
        yield* yieldUntil(() => attempts === index + 1);
      }
      expect(attempts).toBe(11);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("re-delivers only the unacknowledged half of a partially delivered batch", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    const batches: Array<ReadonlyArray<{ id: string; generation: number }>> = [];
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        batches.push(notification.runs.map(({ id, generation }) => ({ id, generation })));
        const first = notification.runs[0];
        return { deliveredCompletionKeys: first ? [`${first.id}:${first.generation}`] : [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const one = yield* service.start(request({ name: "partial-one" }));
      const two = yield* service.start(request({ name: "partial-two" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[1]?.offer({ type: "agent_settled" });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("claiming a queued completion retry removes it from delivery ownership", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        return { deliveredCompletionKeys: [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "claimed-retry" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => attempts === 1);

      // The await claim is serialized against delivery and removes the queued retry.
      const runs = yield* service.awaitTerminal([run.id], "all_finished");
      expect(runs[0]?.state).toBe("completed");
      yield* TestClock.adjust("60 seconds");
      expect(attempts).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("stops pending completion retries when the session scope closes", () => {
    const fake = fakeChildLayer();
    const projections: SubagentProjection[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "completed") return undefined;
        attempts += 1;
        return { deliveredCompletionKeys: [] };
      },
      publish: (projection) => projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service.start(request({ name: "shutdown-retry" }));
        fake.controls[0]?.offer({ type: "agent_settled" });
        yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => attempts === 1);
      }).pipe(Effect.scoped, provideBuiltLayer(layer));

      // The retry fiber is owner-scoped: closing the session scope ends redelivery.
      yield* TestClock.adjust("60 seconds");
      expect(attempts).toBe(1);
    });
  });

  it.effect("emits only one completion for repeated terminal events", () => {
    const fake = fakeChildLayer();
    const notifications: SubagentNotification[] = [];
    const { projections, layer } = localServiceFixture(
      {
        notify: (notification) => notifications.push(notification),
      },
      fake,
    );
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "single-settlement" }));
      fake.controls[0]?.offer({ type: "agent_settled" });
      fake.controls[0]?.offer({ type: "agent_settled" });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length > 0);
      yield* Effect.yieldNow;
      expect((yield* service.status(run.id)).state).toBe("completed");
      expect(
        notifications.filter((notification) => notification.type === "completed"),
      ).toHaveLength(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
