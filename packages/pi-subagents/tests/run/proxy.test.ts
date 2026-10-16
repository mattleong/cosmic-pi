import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  extensionContextFixture,
  recordingExtensionHost,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import { decodeSubagentProxyRequest } from "../../src/tools/proxy-protocol.ts";
import type { BackendProxyResult } from "../../src/backend/model.ts";
import type { LocalPiParentControl } from "../../src/backend/local-pi-protocol.ts";
import {
  acknowledgeCompletions,
  fakeChildLayer,
  localServiceFixture,
  request,
  serviceLayer,
  type FakeChildControl,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";

type ProxyResponse = Extract<LocalPiParentControl, { readonly type: "proxy_response" }>;

const proxyResult = (): BackendProxyResult => ({
  content: [{ type: "text", text: "proxy ok" }],
});

const offerProxyRequest = (control: FakeChildControl, requestId: string) => {
  control.offerIpc({
    channel: "pi-subagents",
    type: "proxy_request",
    requestId,
    tool: "subagent_list",
    argumentsJson: "{}",
  });
};

const offerProxyCancel = (control: FakeChildControl, requestId: string) => {
  control.offerIpc({
    channel: "pi-subagents",
    type: "proxy_cancel",
    requestId,
  });
};

const responseFor = (control: FakeChildControl, requestId: string): ProxyResponse | undefined =>
  control.ipc.find(
    (message): message is ProxyResponse =>
      message.type === "proxy_response" && message.requestId === requestId,
  );

const decodePayloadCode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
);

const payloadCode = (response: ProxyResponse): string =>
  decodePayloadCode(response.payloadJson).code ?? "";

const proxyLayer = (
  fake: ReturnType<typeof fakeChildLayer>,
  started: string[],
  respond: (requestId: string) => Effect.Effect<BackendProxyResult>,
) =>
  serviceLayer({
    proxyHandler: (_service, _callerRunId, req) =>
      Effect.sync(() => void started.push(req.requestId)).pipe(
        Effect.andThen(respond(req.requestId)),
      ),
  }).pipe(Layer.provide(fake.layer));

const hangingHandlerLayer = (
  fake: ReturnType<typeof fakeChildLayer>,
  started: string[],
  release: Deferred.Deferred<void>,
) => proxyLayer(fake, started, () => Deferred.await(release).pipe(Effect.as(proxyResult())));

describe("SubagentService parent proxy executions", () => {
  for (const ending of ["crash", "report"] as const)
    it.effect(`releases a proxied await when its caller ends by ${ending}`, () => {
      const host = recordingExtensionHost();
      const context = extensionContextFixture();
      let observed = false;
      let finalized = false;
      const { fake, layer, notifications } = localServiceFixture({
        notify: acknowledgeCompletions,
        proxyHandler: (service, callerRunId, proxyRequest) => {
          const input = decodeSubagentProxyRequest(proxyRequest);
          if (input instanceof InvalidSubagentRequestError) return Effect.fail(input);
          return executeSubagentActionEffect(
            host.pi,
            { cwd: "/project", projectTrusted: true },
            input,
            () => {
              observed = true;
            },
            context,
            callerRunId,
          ).pipe(
            Effect.provideService(SubagentService, service),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          );
        },
      });
      return withService(layer, function* (service) {
        const parent = yield* service.start(request({ name: "awaiting-parent" }));
        const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
        const caller = fake.controls[0]!;
        caller.offerIpc({
          channel: "pi-subagents",
          type: "proxy_request",
          requestId: "await-child",
          tool: "subagent_await",
          argumentsJson: JSON.stringify({ runIds: [child.id], until: "all_finished" }),
        });
        yield* yieldUntil(() => observed);
        if (ending === "crash") caller.exit(1);
        else caller.settle("Parent report.");
        yield* yieldUntil(() => finalized && caller.released() === 1);
        expect((yield* service.status(child.id)).state).toBe("running");
        expect(fake.controls[1]!.released()).toBe(0);

        let rootObserved = false;
        const replacement = yield* service
          .withAwaitTerminalObservations(
            [child.id],
            "all_finished",
            () => {
              rootObserved = true;
            },
            () => Effect.void,
          )
          .pipe(Effect.forkScoped);
        yield* yieldUntil(() => rootObserved);
        yield* Fiber.interrupt(replacement);

        fake.controls[1]!.settle("Descendant report survives caller cleanup.");
        yield* waitForCompleted(service, child.id);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() =>
          notifications.some(
            (notification) =>
              notification.type === "completed" &&
              notification.runs.some(
                (run) =>
                  run.id === child.id &&
                  run.finalText === "Descendant report survives caller cleanup.",
              ),
          ),
        );
        expect(responseFor(caller, "await-child")).toBeUndefined();
        expect(
          yield* service.withStatusObservations([child.id], ({ observations }) =>
            Effect.succeed(observations[0]?.run.reportStatus),
          ),
        ).toBe("delivered");
      });
    });

  it.effect("keeps an admitted nested launch owned by root after the caller crashes", () =>
    Effect.gen(function* () {
      const promptGate = yield* Deferred.make<void>();
      let finalized = false;
      const { fake, layer, projections } = localServiceFixture(
        {
          proxyHandler: (service, callerRunId) =>
            service.startSessionOwnedFrom(callerRunId, request({ name: "owned-child" })).pipe(
              Effect.as(proxyResult()),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true;
                }),
              ),
            ),
        },
        fakeChildLayer(Effect.void, {
          initialSendGates: [{ spawnIndex: 1, type: "prompt", gate: promptGate }],
        }),
      );
      yield* withService(layer, function* (service) {
        yield* service.start(request({ name: "launching-parent" }));
        const caller = fake.controls[0]!;
        offerProxyRequest(caller, "launch-child");
        yield* Effect.gen(function* () {
          yield* yieldUntil(() => fake.controls[1]?.sent("prompt") === true);
          caller.exit(1);
          yield* yieldUntil(() => finalized && caller.released() === 1);
          expect(fake.controls[1]!.released()).toBe(0);
          expect(responseFor(caller, "launch-child")).toBeUndefined();
        }).pipe(Effect.ensuring(Deferred.succeed(promptGate, undefined)));
        yield* yieldUntil(
          () =>
            projections
              .at(-1)
              ?.runs.some((run) => run.name === "owned-child" && run.state === "running") === true,
        );
        expect(fake.controls[1]!.released()).toBe(0);
      });
    }),
  );

  it.effect("cancels without responding and keeps processing events before cleanup completes", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer();
      const slowCleanup = yield* Deferred.make<void>();
      const started: string[] = [];
      const layer = proxyLayer(fake, started, (requestId) =>
        requestId === "req-1"
          ? Effect.never.pipe(Effect.onInterrupt(() => Deferred.await(slowCleanup)))
          : Effect.succeed(proxyResult()),
      );
      yield* withService(layer, function* (service) {
        yield* service.start(request({ name: "proxy-cancel" }));
        const control = fake.controls[0]!;
        offerProxyRequest(control, "req-1");
        yield* yieldUntil(() => started.includes("req-1"));
        offerProxyRequest(control, "req-2");
        yield* yieldUntil(() => started.includes("req-2"));
        offerProxyCancel(control, "req-1");
        offerProxyRequest(control, "req-3");
        yield* yieldUntil(() => started.includes("req-3"));
        yield* yieldUntil(() => responseFor(control, "req-3") !== undefined);
        expect(responseFor(control, "req-1")).toBeUndefined();
        expect(responseFor(control, "req-2")).toMatchObject({ ok: true });
        yield* Deferred.succeed(slowCleanup, undefined);
      });
    }),
  );

  it.effect("rejects a duplicate active request identity with a conflict response", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer();
      const release = yield* Deferred.make<void>();
      const started: string[] = [];
      const conflict = yield* withService(
        hangingHandlerLayer(fake, started, release),
        function* (service) {
          yield* service.start(request({ name: "proxy-conflict" }));
          const control = fake.controls[0]!;
          offerProxyRequest(control, "same");
          yield* yieldUntil(() => started.includes("same"));
          offerProxyRequest(control, "same");
          yield* yieldUntil(() => responseFor(control, "same") !== undefined);
          return responseFor(control, "same")!;
        },
      );
      expect(conflict).toMatchObject({ ok: false });
      expect(payloadCode(conflict)).toBe("proxy_request_conflict");
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("bounds concurrent executions per run with a capacity response", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer();
      const release = yield* Deferred.make<void>();
      const started: string[] = [];
      const control = yield* withService(
        hangingHandlerLayer(fake, started, release),
        function* (service) {
          yield* service.start(request({ name: "proxy-capacity" }));
          const child = fake.controls[0]!;
          for (let index = 0; index < 16; index += 1) offerProxyRequest(child, `req-${index}`);
          yield* yieldUntil(() => started.length === 16);
          offerProxyRequest(child, "req-16");
          yield* yieldUntil(() => responseFor(child, "req-16") !== undefined);
          return child;
        },
      );
      const rejected = responseFor(control, "req-16")!;
      expect(rejected).toMatchObject({ ok: false });
      expect(payloadCode(rejected)).toBe("proxy_capacity");
      expect(control.ipc.filter((message) => message.type === "proxy_response")).toHaveLength(1);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("interrupts in-flight executions at shutdown without hanging", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer();
      const neverReleased = yield* Deferred.make<void>();
      const started: string[] = [];
      const layer = hangingHandlerLayer(fake, started, neverReleased);
      const control = yield* withService(layer, function* (service) {
        yield* service.start(request({ name: "proxy-shutdown" }));
        const child = fake.controls[0]!;
        offerProxyRequest(child, "req-1");
        yield* yieldUntil(() => started.includes("req-1"));
        return child;
      });
      expect(control.ipc.filter((message) => message.type === "proxy_response")).toEqual([]);
    }),
  );
});
