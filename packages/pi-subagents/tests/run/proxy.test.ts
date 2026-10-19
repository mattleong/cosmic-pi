import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  extensionContextFixture,
  recordingExtensionHost,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService, type SubagentServiceOptions } from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import { decodeSubagentProxyRequest } from "../../src/tools/proxy-protocol.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/run/tool-policy.ts";
import type { BackendProxyResult } from "../../src/backend/model.ts";
import type { LocalPiParentControl } from "../../src/backend/local-pi-protocol.ts";
import {
  acknowledgeCompletions,
  type FakeChildControl,
  fakeChildLayer,
  localServiceFixture,
  request,
  runView,
  serviceLayer,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";
import { stoppedWriter, workspaceFixture } from "./fixtures/workspace-engine.ts";

type ProxyResponse = Extract<LocalPiParentControl, { readonly type: "proxy_response" }>;

const proxyResult = (): BackendProxyResult => ({
  content: [{ type: "text", text: "proxy ok" }],
});

const offerProxyRequest = (control: FakeChildControl, requestId: string) => {
  control.offerIpc({
    channel: "pi-subagents",
    type: "proxy_request",
    requestId,
    tool: "agent_list",
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

/** Routes proxied calls like the root coordinator: the caller is the authenticated channel's run. */
const coordinatorProxyOptions = (): SubagentServiceOptions => {
  const host = recordingExtensionHost();
  const context = extensionContextFixture();
  return {
    proxyHandler: (service, callerRunId, proxyRequest) => {
      const input = decodeSubagentProxyRequest(proxyRequest);
      if (input instanceof InvalidSubagentRequestError) return Effect.fail(input);
      return executeSubagentActionEffect(
        host.pi,
        { cwd: "/repo", projectTrusted: true },
        input,
        undefined,
        context,
        callerRunId,
      ).pipe(Effect.provideService(SubagentService, service));
    },
  };
};

describe("SubagentService parent proxy executions", () => {
  it.effect("binds proxied workspace calls to the authenticated caller", () => {
    const fake = fakeChildLayer();
    const f = workspaceFixture({ children: fake, serviceOptions: coordinatorProxyOptions() });
    return withService(f.layer, function* (service) {
      const writer = yield* stoppedWriter(service);
      const workspaceId = writer.workspaceId!;
      yield* service.start(request({ name: "nested-caller" }));
      const caller = fake.controls[1]!;
      const attempts = [
        { requestId: "review", args: { action: "review", workspaceId } },
        { requestId: "discard", args: { action: "discard", workspaceId } },
        // Arguments cannot name a different caller; strict validation refuses the extra field.
        {
          requestId: "forged",
          args: { action: "discard", workspaceId, callerRunId: "root", ownerId: "session-1/root" },
        },
      ];
      for (const { requestId, args } of attempts)
        caller.offerIpc({
          channel: "pi-subagents",
          type: "proxy_request",
          requestId,
          tool: SUBAGENT_TOOL_NAME.workspace,
          argumentsJson: JSON.stringify(args),
        });
      yield* yieldUntil(() => attempts.every(({ requestId }) => responseFor(caller, requestId)));
      const refusalCode = (requestId: string, code: string) => {
        const response = responseFor(caller, requestId);
        expect(response?.ok).toBe(false);
        expect(response?.payloadJson).toContain(`"code":"${code}"`);
      };
      refusalCode("review", "workspace_owner_unavailable");
      refusalCode("discard", "workspace_owner_unavailable");
      refusalCode("forged", "proxy_request_invalid");
      expect(f.entries.get(workspaceId)?.status).toBe("active");
      // The owner itself still reaches the workspace, so the refusals were about the caller.
      yield* service.workspaceDiscard(workspaceId);
      expect(f.entries.get(workspaceId)?.status).toBe("discarded");
    });
  });

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
          tool: "agent_await",
          argumentsJson: JSON.stringify({ runIds: [child.id], until: "all_finished" }),
        });
        yield* yieldUntil(() => observed);
        if (ending === "crash") caller.exit(1);
        else caller.settle("Parent report.");
        yield* yieldUntil(() => finalized && caller.released() === 1);
        expect((yield* runView(service, child.id)).state).toBe("running");
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
          yield* service.withAwaitTerminalObservations(
            [child.id],
            "all_finished",
            undefined,
            (observations) => Effect.succeed(observations[0]?.run.reportStatus),
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
