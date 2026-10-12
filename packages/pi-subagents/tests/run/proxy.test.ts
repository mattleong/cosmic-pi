import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { BackendProxyResult } from "../../src/backend/model.ts";
import type { LocalPiParentControl } from "../../src/backend/local-pi-protocol.ts";
import {
  fakeChildLayer,
  request,
  serviceLayer,
  type FakeChildControl,
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
