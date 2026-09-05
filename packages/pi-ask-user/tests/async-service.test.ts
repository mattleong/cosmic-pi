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
      key: "library",
      title: "Library",
      prompt: "Which?",
      mode: "single",
      choices: [
        { value: "a", label: "A", description: "First" },
        { value: "b", label: "B", description: "Second" },
      ],
    },
  ],
};
const outcome: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "library", kind: "choices", values: ["a"], labels: ["A"] }],
};

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
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
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
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery, "test")));
  }),
);

it.effect(
  "rejects competing async and blocking dialogs without replacing the pending request",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Deferred.succeed(f.mount, undefined);
      yield* Effect.gen(function* () {
        const service = yield* AskUserService;
        const receipt = yield* service.startAsync(request);
        expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
        expect(yield* Effect.flip(service.ask(request))).toMatchObject({ reason: "busy" });
        const result = yield* service.controlAsync({
          action: "cancel",
          requestId: receipt.requestId,
        });
        expect(result.requests[0]?.status).toBe("cancelled");
        expect(result.requests[0]?.outcome?.answers).toEqual([]);
        expect(yield* Ref.get(f.messages)).toEqual([]);
      }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
    }),
);

it.effect("does not queue async behind an active blocking dialog", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      const blocking = yield* Effect.forkChild(service.ask(request));
      yield* Deferred.await(f.entered);
      expect(yield* Effect.flip(service.startAsync(request))).toMatchObject({ reason: "busy" });
      yield* Fiber.interrupt(blocking);
      yield* Deferred.succeed(f.mount, undefined);
      const receipt = yield* service.startAsync(request);
      expect(receipt.status).toBe("pending");
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
  }),
);

it.effect("an await owns answer delivery; status never consumes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      const receipt = yield* service.startAsync(request);
      const waiter = yield* Effect.forkChild(
        service.controlAsync({ action: "await", requestId: receipt.requestId }),
        { startImmediately: true },
      );
      expect((yield* service.controlAsync({ action: "status" })).requests[0]?.status).toBe(
        "pending",
      );
      expect(
        yield* Effect.flip(service.controlAsync({ action: "await", requestId: receipt.requestId })),
      ).toMatchObject({ reason: "busy" });
      yield* Deferred.succeed(f.answer, outcome);
      const result = yield* Fiber.join(waiter);
      expect(result.requests[0]).toMatchObject({ delivery: "waiter", outcome });
      expect(yield* Ref.get(f.messages)).toEqual([]);
      expect(
        yield* service.controlAsync({ action: "await", requestId: receipt.requestId }),
      ).toEqual(result);
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
  }),
);

it.effect("interrupting an await leaves the UI alive and restores automatic delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      const receipt = yield* service.startAsync(request);
      const waiter = yield* Effect.forkChild(
        service.controlAsync({ action: "await", requestId: receipt.requestId }),
        { startImmediately: true },
      );
      yield* Fiber.interrupt(waiter);
      expect(yield* Ref.get(f.released)).toBe(0);
      expect((yield* service.controlAsync({ action: "status" })).requests[0]?.status).toBe(
        "pending",
      );
      yield* Deferred.succeed(f.answer, outcome);
      yield* Deferred.await(f.delivered);
      expect(yield* Ref.get(f.messages)).toHaveLength(1);
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
  }),
);

it.effect("interruption at the waiter commit boundary restores automatic delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
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
        (yield* service.controlAsync({ action: "status", requestId: receipt.requestId }))
          .requests[0]?.delivery,
      ).toBe("sent");
      expect(yield* Ref.get(f.messages)).toHaveLength(1);
      expect(
        (yield* service.controlAsync({ action: "await", requestId: receipt.requestId }))
          .requests[0],
      ).toMatchObject({ delivery: "sent", outcome });
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
  }),
);

it.effect(
  "interrupting start during mount does not orphan or cancel its session-owned presenter",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const service = yield* AskUserService;
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
      }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
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
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
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
    }).pipe(Effect.provide(AskUserService.layer(f.host, delivery)));
  }),
);

it.effect("cancel signals the presenter while another caller owns await delivery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Deferred.succeed(f.mount, undefined);
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
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
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
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
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
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
      expect(
        (yield* service.controlAsync({ action: "status", requestId: first.requestId })).requests[0],
      ).toMatchObject({ delivery: "failed", outcome });
      const next = yield* service.startAsync(request);
      expect(next.requestId).not.toBe(first.requestId);
    }).pipe(Effect.provide(AskUserService.layer(f.host, delivery)));
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
      expect(
        (yield* service.controlAsync({ action: "status", requestId: oldest })).requests[0],
      ).toMatchObject({ delivery: "failed", outcome });
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
      expect((yield* service.controlAsync({ action: "status" })).requests[0]?.status).toBe(
        "failed",
      );
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
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
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
    }).pipe(Effect.provide(AskUserService.layer(host, () => Effect.void)));
  }),
);

it.effect("retention stays bounded when an old result is claimed during new admission", () =>
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
    }).pipe(Effect.provide(AskUserService.layer(host, () => Effect.void)));
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
      const service = yield* AskUserService;
      for (const work of [" ", "x".repeat(501)])
        expect(
          yield* Effect.flip(service.startAsync({ ...request, blockedWork: work })),
        ).toMatchObject({ _tag: "AskUserValidationError" });
      expect(yield* Effect.flip(service.controlAsync({ action: "await" }))).toMatchObject({
        reason: "invalid-control",
      });
      expect(yield* Ref.get(f.released)).toBe(0);
    }).pipe(Effect.provide(AskUserService.layer(f.host, f.delivery)));
    yield* Effect.gen(function* () {
      expect(yield* Effect.flip((yield* AskUserService).startAsync(request))).toMatchObject({
        reason: "unavailable",
      });
    }).pipe(Effect.provide(AskUserService.layer(f.host)));
  }),
);
