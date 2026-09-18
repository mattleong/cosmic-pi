import { ordinalChoices, defaultQuestion } from "./support/questionnaire.ts";
import { it } from "@effect/vitest";
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
import { AskUserService, type AskUserHost } from "../src/questionnaire/service.ts";
import { AskUserHostError } from "../src/questionnaire/errors.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import {
  MAX_RETAINED_REQUESTS,
  type AsyncQuestionnaireSnapshot,
} from "../src/questionnaire/async-model.ts";
import type { AskUserAsyncRequest } from "../src/questionnaire/schema.ts";

const request: AskUserAsyncRequest = {
  independentWork: "Inspect the test fixtures",
  blockedWork: "Choose the implementation",
  questions: [
    {
      ...defaultQuestion,
      key: "library",
      title: "Library",
      prompt: "Which?",
      choices: ordinalChoices,
    },
  ],
};
const outcome: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "library", kind: "choices", values: ["a"], labels: ["A"] }],
};

// Acquisition stays at each caller's original boundary; the caller owns its scope.
const acquireService = (...args: Parameters<typeof AskUserService.layer>) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(AskUserService.layer(...args), yield* Effect.scope);
    return Context.get(context, AskUserService);
  });

const statusOf = (service: Effect.Success<ReturnType<typeof acquireService>>, requestId?: string) =>
  service
    .controlAsync(requestId === undefined ? { action: "status" } : { action: "status", requestId })
    .pipe(Effect.map((result) => result.requests[0]));

const fixture = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const mount = yield* Deferred.make<void>();
  const answer = yield* Deferred.make<AskUserOutcome, AskUserHostError>();
  const delivered = yield* Deferred.make<void>();
  const released = yield* Ref.make(0);
  const messages = yield* Ref.make<ReadonlyArray<AsyncQuestionnaireSnapshot>>([]);
  const host: AskUserHost = (_request, opened) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(mount);
      if (opened) yield* Deferred.succeed(opened, undefined);
      return yield* Deferred.await(answer);
    }).pipe(Effect.ensuring(Ref.update(released, (n) => n + 1)));
  const delivery = (snapshot: AsyncQuestionnaireSnapshot) =>
    Ref.update(messages, (items) => [...items, snapshot]).pipe(
      Effect.andThen(Deferred.succeed(delivered, undefined)),
      Effect.asVoid,
    );
  return { entered, mount, answer, delivered, released, messages, host, delivery };
});

it.effect("waits only for mounting, admits independent work, and retains automatic answers", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* acquireService(f.host, f.delivery, "test");
    const start = yield* Effect.forkChild(service.startAsync(request));
    yield* Deferred.await(f.entered);
    expect(start.pollUnsafe()).toBeUndefined();
    const pending = yield* service.controlAsync({ action: "status" });
    expect(pending.requests[0]?.status).toBe("pending");
    yield* Deferred.succeed(f.mount, undefined);
    const receipt = yield* Fiber.join(start);
    expect(receipt.status).toBe("pending");
    expect(yield* Ref.get(f.released)).toBe(0);
    expect(yield* Ref.get(f.messages)).toEqual([]);
    yield* Deferred.succeed(f.answer, outcome);
    yield* Deferred.await(f.delivered);
    const status = yield* service.controlAsync({
      action: "status",
      requestId: receipt.requestId,
    });
    expect(status.requests[0]?.outcome).toEqual(outcome);
    expect(status.requests[0]?.delivery).toBe("sent");
    expect((yield* Ref.get(f.messages))[0]?.deliveryId).toBe(receipt.deliveryId);
    expect(yield* Ref.get(f.released)).toBe(1);
  }),
);

it.effect(
  "retains text outcomes with unchanged request and delivery IDs through status and await",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Deferred.succeed(f.mount, undefined);
      const service = yield* acquireService(f.host, f.delivery, "text");
      const receipt = yield* service.startAsync({
        ...request,
        questions: [{ key: "details", title: "Details", prompt: "Describe?", mode: "text" }],
      });
      const textOutcome: AskUserOutcome = {
        outcome: "submitted",
        answers: [{ key: "details", kind: "text", text: "bq1234\nanswer", note: "context" }],
      };
      yield* Deferred.succeed(f.answer, textOutcome);
      yield* Deferred.await(f.delivered);
      const messages = yield* Ref.get(f.messages);
      const status = yield* service.controlAsync({
        action: "status",
        requestId: receipt.requestId,
      });
      const awaited = yield* service.controlAsync({
        action: "await",
        requestId: receipt.requestId,
      });
      for (const result of [messages[0], status.requests[0], awaited.requests[0]]) {
        expect(result?.requestId).toBe(receipt.requestId);
        expect(result?.deliveryId).toBe(receipt.deliveryId);
        expect(result?.outcome).toEqual(textOutcome);
      }
    }),
);

it.effect("queues competing async and blocking dialogs without replacing the pending request", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, f.delivery);
    const receipt = yield* service.startAsync(request);
    expect(yield* service.startAsync(request)).toMatchObject({
      status: "pending",
      presentation: "queued",
    });
    const blocking = yield* Effect.forkChild(service.ask(request), { startImmediately: true });
    expect(blocking.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(blocking);
    const result = yield* service.controlAsync({
      action: "cancel",
      requestId: receipt.requestId,
    });
    expect(result.requests[0]?.status).toBe("cancelled");
    expect(result.requests[0]?.outcome?.answers).toEqual([]);
    expect(yield* Ref.get(f.messages)).toEqual([]);
  }),
);

it.effect("queues async behind an active blocking dialog", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const service = yield* acquireService(f.host, f.delivery);
    const blocking = yield* Effect.forkChild(service.ask(request));
    yield* Deferred.await(f.entered);
    const receipt = yield* service.startAsync(request);
    expect(receipt.presentation).toBe("queued");
    yield* Fiber.interrupt(blocking);
    yield* Deferred.succeed(f.mount, undefined);
    yield* service.controlAsync({ action: "cancel", requestId: receipt.requestId });
  }),
);

it.effect("an await owns answer delivery; status never consumes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, f.delivery);
    const receipt = yield* service.startAsync(request);
    const waiter = yield* Effect.forkChild(
      service.controlAsync({ action: "await", requestId: receipt.requestId }),
      { startImmediately: true },
    );
    expect((yield* statusOf(service))?.status).toBe("pending");
    expect(
      yield* Effect.flip(service.controlAsync({ action: "await", requestId: receipt.requestId })),
    ).toMatchObject({ reason: "busy" });
    yield* Deferred.succeed(f.answer, outcome);
    const result = yield* Fiber.join(waiter);
    expect(result.requests[0]).toMatchObject({ delivery: "waiter", outcome });
    expect(yield* Ref.get(f.messages)).toEqual([]);
    expect(yield* service.controlAsync({ action: "await", requestId: receipt.requestId })).toEqual(
      result,
    );
  }),
);

it.effect("interrupting an await leaves the UI alive and restores automatic delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, f.delivery);
    const receipt = yield* service.startAsync(request);
    const waiter = yield* Effect.forkChild(
      service.controlAsync({ action: "await", requestId: receipt.requestId }),
      { startImmediately: true },
    );
    yield* Fiber.interrupt(waiter);
    expect(yield* Ref.get(f.released)).toBe(0);
    expect((yield* statusOf(service))?.status).toBe("pending");
    yield* Deferred.succeed(f.answer, outcome);
    yield* Deferred.await(f.delivered);
    expect(yield* Ref.get(f.messages)).toHaveLength(1);
  }),
);

it.effect("cancellation after final acknowledgement never redelivers the answer", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, f.delivery);
    const receipt = yield* service.startAsync(request);
    const waiter = yield* Effect.forkChild(
      service
        .controlAsync({ action: "await", requestId: receipt.requestId })
        .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)),
      { startImmediately: true },
    );
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    expect(
      yield* Effect.flip(service.controlAsync({ action: "await", requestId: receipt.requestId })),
    ).toMatchObject({ reason: "busy" });
    yield* Deferred.succeed(f.answer, outcome);
    let observedCommit = false;
    for (let i = 0; i < 100; i++) {
      const status = yield* service.controlAsync({
        action: "status",
        requestId: receipt.requestId,
      });
      if (status.requests[0]?.delivery === "waiter") {
        observedCommit = true;
        waiter.interruptUnsafe();
        break;
      }
      yield* Effect.yieldNow;
    }
    expect(observedCommit).toBe(true);
    expect(Exit.isFailure(yield* Fiber.await(waiter))).toBe(true);
    for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
    expect(
      (yield* service.controlAsync({ action: "status", requestId: receipt.requestId })).requests[0]
        ?.delivery,
    ).toBe("waiter");
    expect(yield* Ref.get(f.messages)).toEqual([]);
    expect(
      (yield* service.controlAsync({ action: "await", requestId: receipt.requestId })).requests[0],
    ).toMatchObject({ delivery: "waiter", outcome });
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
      const listed = yield* service.controlAsync({ action: "status" });
      expect(listed.requests[0]?.outcome).toBeUndefined();
      expect(
        (yield* service.controlAsync({
          action: "status",
          requestId: listed.requests[0]!.requestId,
        })).requests[0]?.outcome,
      ).toEqual(outcome);
    }),
);

it.effect("retains answers when delivery fails and recovers through await with the same ID", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const failed = yield* Deferred.make<void>();
    const attempts = yield* Ref.make(0);
    const delivery = (_snapshot: AsyncQuestionnaireSnapshot) =>
      Deferred.succeed(failed, undefined).pipe(
        Effect.andThen(Ref.update(attempts, (n) => n + 1)),
        Effect.andThen(
          Effect.fail(
            new AskUserHostError({ operation: "deliver", message: "Unable to deliver." }),
          ),
        ),
      );
    const service = yield* acquireService(f.host, delivery);
    const receipt = yield* service.startAsync(request);
    yield* Deferred.succeed(f.answer, outcome);
    yield* Deferred.await(failed);
    const status = yield* service.controlAsync({
      action: "status",
      requestId: receipt.requestId,
    });
    expect(status.requests[0]).toMatchObject({
      outcome,
      delivery: "failed",
      deliveryId: receipt.deliveryId,
    });
    const recovered = yield* service.controlAsync({
      action: "await",
      requestId: receipt.requestId,
    });
    expect(recovered.requests[0]).toMatchObject({
      outcome,
      delivery: "waiter",
      deliveryId: receipt.deliveryId,
    });
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

it.effect("cancel signals the presenter while another caller owns await delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const service = yield* acquireService(f.host, f.delivery);
    const receipt = yield* service.startAsync(request);
    const waiter = yield* Effect.forkChild(
      service.controlAsync({ action: "await", requestId: receipt.requestId }),
      { startImmediately: true },
    );
    const cancelled = yield* service.controlAsync({
      action: "cancel",
      requestId: receipt.requestId,
    });
    expect(cancelled.requests[0]?.status).toBe("cancelled");
    expect((yield* Fiber.join(waiter)).requests[0]?.status).toBe("cancelled");
    expect(yield* Ref.get(f.released)).toBe(1);
    expect(yield* Ref.get(f.messages)).toEqual([]);
  }),
);

it.effect("failed delivery retries are bounded and do not hold admission", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const delivery = () =>
      Ref.update(attempts, (n) => n + 1).pipe(
        Effect.andThen(
          Effect.fail(new AskUserHostError({ operation: "deliver", message: "Failed" })),
        ),
      );
    const service = yield* acquireService(f.host, delivery);
    const first = yield* service.startAsync(request);
    yield* Deferred.succeed(f.answer, outcome);
    yield* Effect.yieldNow;
    expect(yield* Ref.get(attempts)).toBe(1);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(attempts)).toBe(2);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(attempts)).toBe(3);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(attempts)).toBe(3);
    expect(yield* statusOf(service, first.requestId)).toMatchObject({
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
    const delivery = () =>
      Ref.update(attempts, (n) => n + 1).pipe(
        Effect.andThen(
          Effect.fail(new AskUserHostError({ operation: "deliver", message: "Failed" })),
        ),
      );
    yield* Deferred.succeed(f.mount, undefined);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(AskUserService.layer(f.host, delivery), scope);
    yield* Context.get(context, AskUserService).startAsync(request);
    yield* Deferred.succeed(f.answer, outcome);
    yield* Effect.yieldNow;
    expect(yield* Ref.get(attempts)).toBe(1);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(attempts)).toBe(1);
  }),
);

it.effect("retention rejects capacity rather than discarding undelivered answers", () =>
  Effect.gen(function* () {
    const host: AskUserHost = (_request, opened) =>
      Effect.gen(function* () {
        if (opened) yield* Deferred.succeed(opened, undefined);
        return outcome;
      });
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      let oldest = "";
      for (let i = 0; i < MAX_RETAINED_REQUESTS; i++) {
        const receipt = yield* service.startAsync(request);
        if (!oldest) oldest = receipt.requestId;
        yield* Effect.yieldNow;
      }
      expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
      expect(yield* statusOf(service, oldest)).toMatchObject({ delivery: "failed", outcome });
      yield* service.controlAsync({ action: "await", requestId: oldest });
      yield* service.startAsync(request);
      expect(
        yield* Effect.flip(service.controlAsync({ action: "status", requestId: oldest })),
      ).toMatchObject({ reason: "not-found" });
    }).pipe(
      Effect.provide(
        AskUserService.layer(host, () =>
          Effect.fail(new AskUserHostError({ operation: "deliver", message: "Failed" })),
        ),
      ),
    );
  }),
);

it.effect("propagates opening failure and releases admission", () =>
  Effect.gen(function* () {
    const failure = new AskUserHostError({ operation: "open", message: "Unavailable." });
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({
        _tag: "AskUserHostError",
      });
      expect((yield* statusOf(service))?.status).toBe("failed");
      expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({
        _tag: "AskUserHostError",
      });
    }).pipe(
      Effect.provide(
        AskUserService.layer(
          () => Effect.fail(failure),
          () => Effect.void,
        ),
      ),
    );
  }),
);

it.effect("retention evicts old terminal requests and IDs never repeat", () =>
  Effect.gen(function* () {
    const host: AskUserHost = (_request, opened) =>
      Effect.gen(function* () {
        if (opened) yield* Deferred.succeed(opened, undefined);
        return outcome;
      });
    const service = yield* acquireService(host, () => Effect.void);
    const ids: string[] = [];
    for (let i = 0; i < MAX_RETAINED_REQUESTS + 3; i++) {
      const receipt = yield* service.startAsync(request);
      ids.push(receipt.requestId);
      yield* service.controlAsync({ action: "await", requestId: receipt.requestId });
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect((yield* service.controlAsync({ action: "status" })).requests).toHaveLength(
      MAX_RETAINED_REQUESTS,
    );
    expect(
      yield* Effect.flip(service.controlAsync({ action: "status", requestId: ids[0]! })),
    ).toMatchObject({ reason: "not-found" });
  }),
);

it.effect("retention stays bounded when an old result is claimed during new admission", () =>
  Effect.gen(function* () {
    const host: AskUserHost = (_request, opened) =>
      Effect.gen(function* () {
        if (opened) yield* Deferred.succeed(opened, undefined);
        return outcome;
      });
    const service = yield* acquireService(host, () => Effect.void);
    let oldest = "";
    for (let i = 0; i < MAX_RETAINED_REQUESTS; i++) {
      const receipt = yield* service.startAsync(request);
      if (i === 0) oldest = receipt.requestId;
      yield* service.controlAsync({ action: "await", requestId: receipt.requestId });
    }
    // Force scheduler handoffs between Effect operations in the competing transitions.
    const results = yield* Effect.all(
      [
        Effect.exit(service.startAsync(request)),
        Effect.exit(service.controlAsync({ action: "await", requestId: oldest })),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16));
    expect(Exit.isSuccess(results[0]!)).toBe(true);
    expect((yield* service.controlAsync({ action: "status" })).requests).toHaveLength(
      MAX_RETAINED_REQUESTS,
    );
  }),
);

it.effect("scope shutdown closes the presenter and cannot emit an answer afterward", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(AskUserService.layer(f.host, f.delivery), scope);
    const service = Context.get(context, AskUserService);
    yield* service.startAsync(request);
    expect(yield* Ref.get(f.released)).toBe(0);
    yield* Scope.close(scope, Exit.void);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.succeed(f.answer, outcome);
    expect(yield* Ref.get(f.released)).toBe(1);
    expect(yield* Ref.get(f.messages)).toEqual([]);
  }),
);

it.effect("rejects blank work descriptions and unavailable async hosts before opening", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* acquireService(f.host, f.delivery);
      for (const work of [" ", "x".repeat(501)])
        expect(
          yield* Effect.flip(service.startAsync({ ...request, blockedWork: work })),
        ).toMatchObject({ _tag: "AskUserValidationError" });
      expect(yield* Effect.flip(service.controlAsync({ action: "await" }))).toMatchObject({
        reason: "invalid-control",
      });
      expect(yield* Ref.get(f.released)).toBe(0);
    }).pipe(Effect.scoped);
    yield* Effect.gen(function* () {
      expect(yield* Effect.flip((yield* AskUserService).startAsync(request))).toMatchObject({
        reason: "unavailable",
      });
    }).pipe(Effect.provide(AskUserService.layer(f.host)));
  }),
);

it.effect("acknowledging failed openings recovers a full registry after host recovery", () =>
  Effect.gen(function* () {
    const recovered = yield* Ref.make(false);
    const host: AskUserHost = (_request, opened) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(recovered)))
          return yield* new AskUserHostError({ operation: "open", message: "Unavailable" });
        if (opened) yield* Deferred.succeed(opened, undefined);
        return yield* Effect.never;
      });
    const service = yield* acquireService(host, () => Effect.void);
    for (let i = 0; i < MAX_RETAINED_REQUESTS; i++) {
      expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({
        _tag: "AskUserHostError",
      });
    }
    const listed = yield* service.controlAsync({ action: "status" });
    expect(listed.requests).toHaveLength(MAX_RETAINED_REQUESTS);
    expect(
      listed.requests.every((item) => item.status === "failed" && item.delivery === "none"),
    ).toBe(true);
    expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
    for (const item of listed.requests) {
      expect(
        (yield* service.controlAsync({ action: "await", requestId: item.requestId })).requests[0],
      ).toMatchObject({ status: "failed", delivery: "waiter" });
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
      const host: AskUserHost = (input, opened) =>
        Effect.gen(function* () {
          const key = input.questions[0]!.key;
          yield* Ref.update(mounted, (items) => [...items, key]);
          if (opened) yield* Deferred.succeed(opened, undefined);
          return yield* Deferred.await(answers[Number(key)]!);
        }).pipe(
          Effect.ensuring(input.questions[0]!.key === "0" ? Deferred.await(cleanup) : Effect.void),
        );
      const input = (index: number) => ({
        ...request,
        questions: [{ ...request.questions[0]!, key: String(index) }],
      });
      const service = yield* acquireService(host, () => Effect.void);
      const first = yield* service.startAsync(input(0));
      const second = yield* service.startAsync(input(1));
      const third = yield* service.startAsync(input(2));
      expect(second.presentation).toBe("queued");
      expect(third.presentation).toBe("queued");
      yield* service.controlAsync({ action: "cancel", requestId: second.requestId });
      expect(yield* Ref.get(mounted)).toEqual(["0"]);
      yield* Deferred.succeed(answers[0]!, outcome);
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
    const context = yield* Layer.buildWithScope(AskUserService.layer(f.host, f.delivery), scope);
    const service = Context.get(context, AskUserService);
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

const pausedScheduler = () => {
  const tasks: Array<() => void> = [];
  const scheduler: Scheduler.Scheduler = {
    executionMode: "async",
    shouldYield: (fiber) => fiber.currentOpCount >= fiber.maxOpsBeforeYield,
    makeDispatcher: () => ({
      scheduleTask: (task) => {
        tasks.push(task);
      },
      flush: () => {
        while (tasks.length) tasks.shift()!();
      },
    }),
  };
  return { scheduler, step: () => tasks.shift()?.() };
};

for (const prior of ["none", "pending", "failed"] as const) {
  for (const budget of [8, 16]) {
    for (const interruptSuccessor of [false, true]) {
      it.effect(
        `acknowledgement is atomic across cancellation (${prior}, budget ${budget}, successor interrupted ${interruptSuccessor})`,
        () =>
          Effect.gen(function* () {
            let beforeCommit = false;
            let afterCommit = false;
            // Stop at each scheduler chunk through preparation and finalization.
            for (let checkpoint = -1; checkpoint < 24; checkpoint++) {
              const f = yield* fixture;
              const attempts = yield* Ref.make(0);
              const delivery = (snapshot: AsyncQuestionnaireSnapshot) =>
                Effect.gen(function* () {
                  if (prior === "failed" && (yield* Ref.updateAndGet(attempts, (n) => n + 1)) === 1)
                    return yield* new AskUserHostError({ operation: "deliver", message: "Failed" });
                  yield* f.delivery(snapshot);
                });
              yield* Deferred.succeed(f.mount, undefined);
              yield* Effect.gen(function* () {
                const service = yield* acquireService(f.host, delivery);
                const receipt = yield* service.startAsync(request);
                const awaitResult = service.controlAsync({
                  action: "await",
                  requestId: receipt.requestId,
                });
                const status = service.controlAsync({
                  action: "status",
                  requestId: receipt.requestId,
                });
                if (prior === "failed") {
                  yield* Deferred.succeed(f.answer, outcome);
                  yield* Effect.yieldNow;
                }
                const paused = pausedScheduler();
                const first = yield* Effect.forkChild(
                  awaitResult.pipe(
                    Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
                    Effect.provideService(Scheduler.Scheduler, paused.scheduler),
                  ),
                  { startImmediately: true },
                );
                if (prior !== "failed") {
                  for (let i = 0; i < 20; i++) paused.step();
                  if (checkpoint === -1) first.interruptUnsafe();
                  if (prior === "none")
                    yield* Deferred.fail(
                      f.answer,
                      new AskUserHostError({ operation: "open", message: "Unavailable" }),
                    );
                  else yield* Deferred.succeed(f.answer, outcome);
                  yield* Effect.yieldNow;
                }
                for (let i = 0; i < checkpoint; i++) paused.step();
                const published = (yield* status).requests[0]!.delivery === "waiter";
                beforeCommit ||= !published;
                afterCommit ||= published;
                first.interruptUnsafe();
                // A published acknowledgement also proves claim release. Run B
                // while A's post-release cleanup is still paused where possible.
                if (!published) {
                  for (let i = 0; i < 100; i++) paused.step();
                  expect((yield* status).requests[0]?.delivery).toBe(
                    prior === "pending" ? "sent" : prior,
                  );
                }
                let secondPublished = false;
                if (interruptSuccessor) {
                  const successor = pausedScheduler();
                  const second = yield* Effect.forkChild(
                    awaitResult.pipe(
                      Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
                      Effect.provideService(Scheduler.Scheduler, successor.scheduler),
                    ),
                    { startImmediately: true },
                  );
                  for (let i = 0; i < checkpoint; i++) successor.step();
                  secondPublished = (yield* status).requests[0]!.delivery === "waiter";
                  second.interruptUnsafe();
                  for (let i = 0; i < 100; i++) successor.step();
                  yield* Fiber.await(second);
                } else {
                  const result = yield* awaitResult;
                  secondPublished = result.requests[0]!.delivery === "waiter";
                }
                for (let i = 0; i < 100; i++) paused.step();
                yield* Fiber.await(first);
                yield* Effect.yieldNow;
                const acknowledged = published || secondPublished;
                const expected = acknowledged ? "waiter" : prior === "pending" ? "sent" : prior;
                expect((yield* status).requests[0]?.delivery).toBe(expected);
                if (prior === "none") expect(yield* Ref.get(f.messages)).toEqual([]);
                if (prior === "failed") {
                  yield* TestClock.adjust("1 second");
                  for (let i = 0; i < 100; i++) paused.step();
                  expect((yield* status).requests[0]?.delivery).toBe(
                    acknowledged ? "waiter" : "sent",
                  );
                }
              }).pipe(Effect.scoped);
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
    const id = (yield* statusOf(service))!.requestId;
    const waiter = yield* Effect.forkChild(
      service
        .controlAsync({ action: "await", requestId: id })
        .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 16)),
      { startImmediately: true },
    );
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
    yield* Deferred.fail(
      f.answer,
      new AskUserHostError({ operation: "open", message: "Unavailable" }),
    );
    yield* Deferred.succeed(f.mount, undefined);
    let observedCommit = false;
    for (let i = 0; i < 100; i++) {
      if ((yield* statusOf(service, id))?.delivery === "waiter") {
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
    expect(yield* statusOf(service, id)).toMatchObject({ status: "failed", delivery: "waiter" });
    expect(yield* Ref.get(f.messages)).toEqual([]);
    expect(
      (yield* service.controlAsync({ action: "await", requestId: id })).requests[0]?.delivery,
    ).toBe("waiter");
  }),
);
