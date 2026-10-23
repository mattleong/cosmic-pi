import { asyncRequest as request } from "./support/questionnaire.ts";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { failureMessage } from "pi-cosmic-core";
import { pausedScheduler } from "pi-cosmic-core/testing";
import {
  AskUserService,
  noQuestionnaireActivity,
  type AskUserHost,
  type QuestionnaireActivity,
} from "../src/questionnaire/service.ts";
import { AskUserHostError, AskUserRuntimeClosedError } from "../src/questionnaire/errors.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import {
  MAX_RETAINED_REQUESTS,
  type AsyncQuestionnaireSnapshot,
} from "../src/questionnaire/async-model.ts";
import type { AskUserAsyncControl } from "../src/questionnaire/schema.ts";

const outcome: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "library", kind: "choices", values: ["a"], labels: ["A"] }],
};

const keyedRequest = (index: number) => ({
  ...request,
  questions: [{ ...request.questions[0]!, key: String(index) }],
});

const acquireService = (...args: Parameters<typeof AskUserService.layer>) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(AskUserService.layer(...args), yield* Effect.scope);
    return Context.get(context, AskUserService);
  });

const control = (
  service: Effect.Success<ReturnType<typeof acquireService>>,
  action: AskUserAsyncControl["action"],
  requestId?: string,
) =>
  service
    .controlAsync(requestId === undefined ? { action } : { action, requestId })
    .pipe(Effect.map((result) => result.requests[0]));

const immediateHost: AskUserHost = (_request, presence) =>
  Effect.gen(function* () {
    if (presence) yield* Deferred.succeed(presence.opened, undefined);
    return outcome;
  });

const failingDelivery = (attempts: Ref.Ref<number>) => () =>
  Ref.update(attempts, (n) => n + 1).pipe(
    Effect.andThen(Effect.fail(AskUserHostError.make({ operation: "deliver", message: "Failed" }))),
  );

const fixture = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const mount = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<AskUserOutcome, AskUserHostError>();
  const delivered = yield* Deferred.make<void>();
  const released = yield* Ref.make(0);
  const messages = yield* Ref.make<ReadonlyArray<AsyncQuestionnaireSnapshot>>([]);
  const host: AskUserHost = (_request, presence) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(mount);
      if (presence) yield* Deferred.succeed(presence.opened, undefined);
      return yield* Deferred.await(answer);
    }).pipe(Effect.ensuring(Ref.update(released, (n) => n + 1)));
  const delivery = (snapshot: AsyncQuestionnaireSnapshot) =>
    Ref.update(messages, (items) => [...items, snapshot]).pipe(
      Effect.andThen(Deferred.succeed(delivered, undefined)),
      Effect.asVoid,
    );
  return { entered, mount, answer, delivered, released, messages, host, delivery };
});

const startMounted = (delivery?: Parameters<typeof AskUserService.layer>[1]) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, delivery ?? f.delivery);
    return { f, service, receipt: yield* service.startAsync(request) };
  });

it.effect("waits only for mounting, admits independent work, and retains automatic answers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* acquireService(f.host, f.delivery, "test");
    const start = yield* Effect.forkChild(service.startAsync(request));
    yield* Deferred.await(f.entered);
    expect(start.pollUnsafe()).toBeUndefined();
    expect((yield* control(service, "status"))?.status).toBe("pending");
    yield* Deferred.succeed(f.mount, undefined);
    const receipt = yield* Fiber.join(start);
    expect(receipt.status).toBe("pending");
    expect(yield* Ref.get(f.released)).toBe(0);
    expect(yield* Ref.get(f.messages)).toEqual([]);
    yield* Deferred.succeed(f.answer, outcome);
    yield* Deferred.await(f.delivered);
    const status = yield* control(service, "status", receipt.requestId);
    expect(status?.outcome).toEqual(outcome);
    expect(status?.delivery).toBe("sent");
    expect((yield* Ref.get(f.messages))[0]?.deliveryId).toBe(receipt.deliveryId);
    expect(yield* Ref.get(f.released)).toBe(1);
  }),
);

it.effect("an await owns answer delivery; status never consumes it", () =>
  Effect.gen(function* () {
    const { f, service, receipt } = yield* startMounted();
    const waiter = yield* Effect.forkChild(control(service, "await", receipt.requestId), {
      startImmediately: true,
    });
    expect((yield* control(service, "status"))?.status).toBe("pending");
    expect(yield* Effect.flip(control(service, "await", receipt.requestId))).toMatchObject({
      reason: "busy",
    });
    yield* Deferred.succeed(f.answer, outcome);
    const result = yield* Fiber.join(waiter);
    expect(result).toMatchObject({ delivery: "waiter", outcome });
    expect(yield* Ref.get(f.messages)).toEqual([]);
    expect(yield* control(service, "await", receipt.requestId)).toEqual(result);
  }),
);

it.effect("interrupting an await leaves the UI alive and restores automatic delivery", () =>
  Effect.gen(function* () {
    const { f, service, receipt } = yield* startMounted();
    const waiter = yield* Effect.forkChild(control(service, "await", receipt.requestId), {
      startImmediately: true,
    });
    yield* Fiber.interrupt(waiter);
    expect(yield* Ref.get(f.released)).toBe(0);
    expect((yield* control(service, "status"))?.status).toBe("pending");
    yield* Deferred.succeed(f.answer, outcome);
    yield* Deferred.await(f.delivered);
    expect(yield* Ref.get(f.messages)).toHaveLength(1);
  }),
);

it.effect(
  "interrupting start during mount does not orphan or cancel its session-owned presenter",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const service = yield* acquireService(f.host, f.delivery);
      const start = yield* Effect.forkChild(service.startAsync(request));
      yield* Deferred.await(f.entered);
      yield* Fiber.interrupt(start);
      expect(yield* Ref.get(f.released)).toBe(0);
      yield* Deferred.succeed(f.mount, undefined);
      yield* Deferred.succeed(f.answer, outcome);
      yield* Deferred.await(f.delivered);
      const listed = yield* control(service, "status");
      expect(listed?.outcome).toBeUndefined();
      expect((yield* control(service, "status", listed!.requestId))?.outcome).toEqual(outcome);
    }),
);

it.effect("retains answers when delivery fails and recovers through await with the same ID", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    const attempts = yield* Ref.make(0);
    const { f, service, receipt } = yield* startMounted(() =>
      Deferred.succeed(failed, undefined).pipe(Effect.andThen(failingDelivery(attempts)())),
    );
    yield* Deferred.succeed(f.answer, outcome);
    yield* Deferred.await(failed);
    expect(yield* control(service, "status", receipt.requestId)).toMatchObject({
      outcome,
      delivery: "failed",
      deliveryId: receipt.deliveryId,
    });
    expect(yield* control(service, "await", receipt.requestId)).toMatchObject({
      outcome,
      delivery: "waiter",
      deliveryId: receipt.deliveryId,
    });
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

it.effect("failed delivery retries are bounded and do not hold admission", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const { f, service, receipt: first } = yield* startMounted(failingDelivery(attempts));
    yield* Deferred.succeed(f.answer, outcome);
    yield* Effect.yieldNow;
    expect(yield* Ref.get(attempts)).toBe(1);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(attempts)).toBe(2);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(attempts)).toBe(3);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(attempts)).toBe(3);
    expect(yield* control(service, "status", first.requestId)).toMatchObject({
      delivery: "failed",
      outcome,
    });
    const next = yield* service.startAsync(request);
    expect(next.requestId).not.toBe(first.requestId);
  }),
);

it.effect("scope shutdown cancels scheduled retries without losing or publishing answers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const attempts = yield* Ref.make(0);
    yield* Deferred.succeed(f.mount, undefined);
    const scope = yield* Scope.make();
    const service = yield* acquireService(f.host, failingDelivery(attempts)).pipe(
      Scope.provide(scope),
    );
    yield* service.startAsync(request);
    yield* Deferred.succeed(f.answer, outcome);
    yield* Effect.yieldNow;
    expect(yield* Ref.get(attempts)).toBe(1);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

for (const deliveryMode of ["absent", "failing"] as const) {
  it.effect(
    `retains undelivered answers until await acknowledges them (${deliveryMode} delivery)`,
    () =>
      Effect.gen(function* () {
        const attempts = yield* Ref.make(0);
        const service = yield* acquireService(
          immediateHost,
          deliveryMode === "failing" ? failingDelivery(attempts) : undefined,
        );
        let oldest = "";
        for (let i = 0; i < MAX_RETAINED_REQUESTS; i++) {
          const receipt = yield* service.startAsync(request);
          if (!oldest) oldest = receipt.requestId;
          yield* Effect.yieldNow;
        }
        expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
        expect(yield* control(service, "status", oldest)).toMatchObject({
          delivery: deliveryMode === "failing" ? "failed" : "pending",
          outcome,
        });
        expect(yield* control(service, "await", oldest)).toMatchObject({
          delivery: "waiter",
          outcome,
        });
        yield* service.startAsync(request);
        const missing = yield* Effect.flip(control(service, "status", oldest));
        expect(missing).toMatchObject({ reason: "not-found" });
        expect(
          issueMessageStyleProblems(failureMessage(missing.message, ""), { forbidden: [oldest] }),
        ).toEqual([]);
      }),
  );
}

it.effect("retention evicts old terminal requests, never repeats IDs, and stays bounded", () =>
  Effect.gen(function* () {
    const service = yield* acquireService(immediateHost, () => Effect.void);
    const retained = () =>
      service.controlAsync({ action: "status" }).pipe(Effect.map((result) => result.requests));
    const ids: string[] = [];
    for (let i = 0; i < MAX_RETAINED_REQUESTS + 3; i++) {
      const receipt = yield* service.startAsync(request);
      ids.push(receipt.requestId);
      yield* control(service, "await", receipt.requestId);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(yield* retained()).toHaveLength(MAX_RETAINED_REQUESTS);
    expect(yield* Effect.flip(control(service, "status", ids[0]))).toMatchObject({
      reason: "not-found",
    });
    const results = yield* Effect.all(
      [
        Effect.exit(service.startAsync(request)),
        Effect.exit(service.controlAsync({ action: "await", requestId: ids[3]! })),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16));
    expect(Exit.isSuccess(results[0])).toBe(true);
    expect(yield* retained()).toHaveLength(MAX_RETAINED_REQUESTS);
  }),
);

it.effect("scope shutdown closes the presenter and cannot emit an answer afterward", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const scope = yield* Scope.make();
    const service = yield* acquireService(f.host, f.delivery).pipe(Scope.provide(scope));
    yield* service.startAsync(request);
    expect(yield* Ref.get(f.released)).toBe(0);
    yield* Scope.close(scope, Exit.void);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.succeed(f.answer, outcome);
    expect(yield* Ref.get(f.released)).toBe(1);
    expect(yield* Ref.get(f.messages)).toEqual([]);
  }),
);

it.effect("failed openings report the host failure and recover a full registry", () =>
  Effect.gen(function* () {
    const recovered = yield* Ref.make(false);
    const unavailable = AskUserHostError.make({ operation: "open", message: "Unavailable" });
    const host: AskUserHost = (_request, presence) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(recovered))) return yield* unavailable;
        if (presence) yield* Deferred.succeed(presence.opened, undefined);
        return yield* Effect.never;
      });
    const service = yield* acquireService(host, () => Effect.void);
    for (let i = 0; i < MAX_RETAINED_REQUESTS; i++) {
      expect(yield* Effect.flip(service.startAsync(request))).toBe(unavailable);
    }
    const listed = yield* service.controlAsync({ action: "status" });
    expect(listed.requests).toHaveLength(MAX_RETAINED_REQUESTS);
    expect(
      Arr.every(listed.requests, (item) => item.status === "failed" && item.delivery === "none"),
    ).toBe(true);
    expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
    for (const item of listed.requests) {
      expect(yield* control(service, "await", item.requestId)).toMatchObject({
        status: "failed",
        delivery: "waiter",
      });
    }
    yield* Ref.set(recovered, true);
    const receipt = yield* service.startAsync(request);
    expect(receipt.status).toBe("pending");
    expect(
      yield* Effect.flip(
        service.controlAsync({ action: "status", requestId: listed.requests[0]!.requestId }),
      ),
    ).toMatchObject({ reason: "not-found" });
  }),
);

it.effect(
  "queued cancellation preserves FIFO, waits for cleanup, and does not mount successors early",
  () =>
    Effect.gen(function* () {
      const answers = yield* Effect.all([
        Deferred.make<AskUserOutcome>(),
        Deferred.make<AskUserOutcome>(),
        Deferred.make<AskUserOutcome>(),
      ]);
      const cleanup = yield* Deferred.make<void>();
      const mounted = yield* Ref.make<string[]>([]);
      const host: AskUserHost = (input, presence) =>
        Effect.gen(function* () {
          const key = input.questions[0]!.key;
          yield* Ref.update(mounted, (items) => [...items, key]);
          if (presence) yield* Deferred.succeed(presence.opened, undefined);
          return yield* Deferred.await(answers[Number(key)]!);
        }).pipe(
          Effect.ensuring(input.questions[0]!.key === "0" ? Deferred.await(cleanup) : Effect.void),
        );
      const service = yield* acquireService(host, () => Effect.void);
      const first = yield* service.startAsync(keyedRequest(0));
      const second = yield* service.startAsync(keyedRequest(1));
      const third = yield* service.startAsync(keyedRequest(2));
      expect(second.presentation).toBe("queued");
      expect(third.presentation).toBe("queued");
      yield* service.controlAsync({ action: "cancel", requestId: second.requestId });
      expect(yield* Ref.get(mounted)).toEqual(["0"]);
      yield* Deferred.succeed(answers[0], outcome);
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
      expect(yield* Ref.get(mounted)).toEqual(["0"]);
      yield* Deferred.succeed(cleanup, undefined);
      yield* service.controlAsync({ action: "await", requestId: first.requestId });
      for (let i = 0; i < 30; i++) yield* Effect.yieldNow;
      expect(yield* Ref.get(mounted)).toEqual(["0", "2"]);
      yield* service.controlAsync({ action: "cancel", requestId: third.requestId });
    }),
);

it.effect("queued admission is bounded and shutdown never mounts waiting requests", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const scope = yield* Scope.make();
    const service = yield* acquireService(f.host, f.delivery).pipe(Scope.provide(scope));
    for (let i = 0; i < MAX_RETAINED_REQUESTS; i++) yield* service.startAsync(request);
    expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
    expect((yield* service.controlAsync({ action: "status" })).requests).toHaveLength(
      MAX_RETAINED_REQUESTS,
    );
    yield* Scope.close(scope, Exit.void);
    expect(yield* Ref.get(f.released)).toBe(1);
    expect(yield* Ref.get(f.messages)).toEqual([]);
  }),
);

it.effect("shutdown never mounts a blocking request queued behind an active questionnaire", () =>
  Effect.gen(function* () {
    const mounted = yield* Ref.make<ReadonlyArray<string>>([]);
    const host: AskUserHost = (input, presence) =>
      Effect.gen(function* () {
        yield* Ref.update(mounted, (items) => [...items, input.questions[0]!.key]);
        if (!presence) return outcome;
        yield* Deferred.succeed(presence.opened, undefined);
        return yield* Effect.never;
      });
    const scope = yield* Scope.make();
    const service = yield* acquireService(host, () => Effect.void).pipe(Scope.provide(scope));
    yield* service.startAsync(keyedRequest(0));
    const blocking = yield* Effect.forkChild(service.ask(keyedRequest(1)), {
      startImmediately: true,
    });
    yield* Scope.close(scope, Exit.void);
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    expect(yield* Ref.get(mounted)).toEqual(["0"]);
    expect(yield* Effect.flip(Fiber.join(blocking))).toBeInstanceOf(AskUserRuntimeClosedError);
  }),
);

it.effect("shutdown settles an in-progress await and an opening start with a closed error", () =>
  Effect.gen(function* () {
    const mountedScope = yield* Scope.make();
    const { service } = yield* startMounted().pipe(Scope.provide(mountedScope));
    const id = (yield* control(service, "status"))!.requestId;
    const waiter = yield* Effect.forkChild(control(service, "await", id), {
      startImmediately: true,
    });
    yield* Scope.close(mountedScope, Exit.void);
    expect(yield* Effect.flip(Fiber.join(waiter))).toBeInstanceOf(AskUserRuntimeClosedError);

    const f = yield* fixture;
    const openingScope = yield* Scope.make();
    const opening = yield* acquireService(f.host, f.delivery).pipe(Scope.provide(openingScope));
    const start = yield* Effect.forkChild(opening.startAsync(request));
    yield* Deferred.await(f.entered);
    yield* Scope.close(openingScope, Exit.void);
    expect(yield* Effect.flip(Fiber.join(start))).toBeInstanceOf(AskUserRuntimeClosedError);
  }),
);

const mountedHost: AskUserHost = (_request, presence) =>
  Effect.gen(function* () {
    if (presence) yield* Deferred.succeed(presence.opened, undefined);
    return yield* Effect.never;
  });

it.effect("a queued presenter released by shutdown settles its waiter with the closed error", () =>
  Effect.gen(function* () {
    const permitHeld = yield* Deferred.make<void>();
    const releasePermit = yield* Deferred.make<void>();
    // Holding admission keeps the shutdown finalizer waiting while queue closure wakes presenters.
    const activity: QuestionnaireActivity = {
      ...noQuestionnaireActivity,
      admitted: (id) =>
        id === "ask-3"
          ? Deferred.succeed(permitHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releasePermit)),
            )
          : Effect.void,
    };
    const scope = yield* Scope.make();
    const service = yield* acquireService(mountedHost, () => Effect.void, undefined, activity).pipe(
      Scope.provide(scope),
    );
    yield* service.startAsync(keyedRequest(0));
    const queued = yield* service.startAsync(keyedRequest(1));
    const waiter = yield* Effect.forkChild(control(service, "await", queued.requestId), {
      startImmediately: true,
    });
    const holding = yield* Effect.forkChild(service.startAsync(keyedRequest(2)), {
      startImmediately: true,
    });
    yield* Deferred.await(permitHeld);
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
      startImmediately: true,
    });
    const waited = yield* Effect.flip(Fiber.join(waiter)).pipe(Effect.exit);
    yield* Deferred.succeed(releasePermit, undefined);
    yield* Fiber.join(closing);
    yield* Effect.exit(Fiber.join(holding));
    expect(Exit.isSuccess(waited) && waited.value).toBeInstanceOf(AskUserRuntimeClosedError);
  }),
);

type AcknowledgementPrior = "none" | "pending" | "failed";

interface AcknowledgementScenario {
  readonly prior: AcknowledgementPrior;
  readonly budget: number;
  readonly interruptSuccessor: boolean;
}

type AsyncService = Effect.Success<ReturnType<typeof acquireService>>;
type AwaitResult = ReturnType<AsyncService["controlAsync"]>;
type RequestStatus = ReturnType<typeof control>;
type Fixture = Effect.Success<typeof fixture>;
type PausedScheduler = ReturnType<typeof pausedScheduler>;

const unacknowledgedDelivery = (prior: AcknowledgementPrior) =>
  prior === "pending" ? "sent" : prior;

const stepTimes = (paused: PausedScheduler, count: number) => {
  for (let i = 0; i < count; i++) paused.step();
};

const settleAnswer = (f: Fixture, prior: AcknowledgementPrior) =>
  prior === "none"
    ? Deferred.fail(f.answer, AskUserHostError.make({ operation: "open", message: "Unavailable" }))
    : Deferred.succeed(f.answer, outcome);

const priorDelivery = (f: Fixture, prior: AcknowledgementPrior) =>
  Ref.make(0).pipe(
    Effect.map(
      (attempts) => (snapshot: AsyncQuestionnaireSnapshot) =>
        Effect.gen(function* () {
          if (prior === "failed" && (yield* Ref.updateAndGet(attempts, (n) => n + 1)) === 1)
            return yield* AskUserHostError.make({ operation: "deliver", message: "Failed" });
          yield* f.delivery(snapshot);
          return undefined;
        }),
    ),
  );

const forkPausedAwait = (awaitResult: AwaitResult, budget: number) =>
  Effect.gen(function* () {
    const paused = pausedScheduler();
    const fiber = yield* Effect.forkChild(
      awaitResult.pipe(
        Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
        Effect.provideService(Scheduler.Scheduler, paused.scheduler),
      ),
      { startImmediately: true },
    );
    return { paused, fiber };
  });

const secondAcknowledgement = (
  awaitResult: AwaitResult,
  status: RequestStatus,
  scenario: AcknowledgementScenario,
  checkpoint: number,
) =>
  Effect.gen(function* () {
    if (!scenario.interruptSuccessor) {
      const result = (yield* awaitResult).requests[0]!;
      if (scenario.prior !== "none") expect(result.outcome).toEqual(outcome);
      return result.delivery === "waiter";
    }
    const successor = yield* forkPausedAwait(awaitResult, scenario.budget);
    stepTimes(successor.paused, checkpoint);
    const published = (yield* status)!.delivery === "waiter";
    successor.fiber.interruptUnsafe();
    stepTimes(successor.paused, 100);
    yield* Fiber.await(successor.fiber);
    return published;
  });

const acknowledgementAttempt = (
  f: Fixture,
  scenario: AcknowledgementScenario,
  checkpoint: number,
) =>
  Effect.gen(function* () {
    const { prior } = scenario;
    const delivery = yield* priorDelivery(f, prior);
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, delivery);
    const receipt = yield* service.startAsync(request);
    const awaitResult = service.controlAsync({ action: "await", requestId: receipt.requestId });
    const status = control(service, "status", receipt.requestId);
    if (prior === "failed") {
      yield* settleAnswer(f, prior);
      yield* Effect.yieldNow;
    }
    const first = yield* forkPausedAwait(awaitResult, scenario.budget);
    if (prior !== "failed") {
      stepTimes(first.paused, 20);
      if (checkpoint === -1) first.fiber.interruptUnsafe();
      yield* settleAnswer(f, prior);
      yield* Effect.yieldNow;
    }
    stepTimes(first.paused, checkpoint);
    const published = (yield* status)!.delivery === "waiter";
    first.fiber.interruptUnsafe();
    if (!published) {
      stepTimes(first.paused, 100);
      expect((yield* status)?.delivery).toBe(unacknowledgedDelivery(prior));
    }
    const secondPublished = yield* secondAcknowledgement(awaitResult, status, scenario, checkpoint);
    stepTimes(first.paused, 100);
    yield* Fiber.await(first.fiber);
    yield* Effect.yieldNow;
    const acknowledged = published || secondPublished;
    expect((yield* status)?.delivery).toBe(acknowledged ? "waiter" : unacknowledgedDelivery(prior));
    if (prior === "failed") {
      yield* TestClock.adjust("1 second");
      stepTimes(first.paused, 100);
      expect((yield* status)?.delivery).toBe(acknowledged ? "waiter" : "sent");
    }
    if (prior === "none" || published) expect(yield* Ref.get(f.messages)).toEqual([]);
    return published;
  }).pipe(Effect.scoped);

for (const prior of ["none", "pending", "failed"] as const) {
  for (const budget of [8, 16]) {
    for (const interruptSuccessor of [false, true]) {
      it.effect(
        `acknowledgement is atomic across cancellation (${prior}, budget ${budget}, successor interrupted ${interruptSuccessor})`,
        () =>
          Effect.gen(function* () {
            let beforeCommit = false;
            let afterCommit = false;
            for (let checkpoint = -1; checkpoint < 24; checkpoint++) {
              const f = yield* fixture;
              const published = yield* acknowledgementAttempt(
                f,
                { prior, budget, interruptSuccessor },
                checkpoint,
              );
              beforeCommit ||= !published;
              afterCommit ||= published;
            }
            expect(beforeCommit).toBe(true);
            expect(afterCommit).toBe(true);
          }),
      );
    }
  }
}

it.effect("cancellation after final failed-opening acknowledgement retains it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* acquireService(f.host, f.delivery);
    const opening = yield* Effect.forkChild(service.startAsync(request));
    yield* Deferred.await(f.entered);
    const id = (yield* control(service, "status"))!.requestId;
    const waiter = yield* Effect.forkChild(
      service
        .controlAsync({ action: "await", requestId: id })
        .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)),
      { startImmediately: true },
    );
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    yield* Deferred.fail(
      f.answer,
      AskUserHostError.make({ operation: "open", message: "Unavailable" }),
    );
    yield* Deferred.succeed(f.mount, undefined);
    let observedCommit = false;
    for (let i = 0; i < 100; i++) {
      if ((yield* control(service, "status", id))?.delivery === "waiter") {
        observedCommit = true;
        waiter.interruptUnsafe();
        break;
      }
      yield* Effect.yieldNow;
    }
    expect(observedCommit).toBe(true);
    expect(Exit.isFailure(yield* Fiber.await(waiter))).toBe(true);
    yield* Fiber.await(opening);
    for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
    expect(yield* control(service, "status", id)).toMatchObject({
      status: "failed",
      delivery: "waiter",
    });
    expect(yield* Ref.get(f.messages)).toEqual([]);
    expect((yield* control(service, "await", id))?.delivery).toBe("waiter");
  }),
);
