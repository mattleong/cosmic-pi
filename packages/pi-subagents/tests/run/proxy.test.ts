import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  extensionContextFixture,
  recordingExtensionHost,
  yieldUntil,
} from "pi-cosmic-core/testing";
import {
  SubagentService,
  type SubagentServiceContract,
  type SubagentServiceOptions,
} from "../../src/run/service.ts";
import { executeSubagentActionEffect } from "../../src/tools/execute.ts";
import {
  decodeSubagentProxyRequest,
  decodeSubagentProxyResult,
} from "../../src/tools/proxy-protocol.ts";
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
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

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
  Option.getOrUndefined(
    Arr.findFirst(
      Arr.filter(control.ipc, (message) => message.type === "proxy_response"),
      (message) => message.requestId === requestId,
    ),
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
      if (Result.isFailure(input)) return Effect.fail(input.failure);
      return executeSubagentActionEffect(
        host.pi,
        { cwd: "/repo", projectTrusted: true },
        input.success,
        undefined,
        context,
        callerRunId,
      ).pipe(Effect.provideService(SubagentService, service));
    },
  };
};

/** A root coordinator for nested awaits, optionally over an intercepted service. */
const nestedAwaitFixture = (
  intercept: (service: SubagentServiceContract) => SubagentServiceContract = (service) => service,
) => {
  const host = recordingExtensionHost();
  const context = extensionContextFixture();
  const progress = { observed: 0 };
  const fixture = localServiceFixture({
    notify: acknowledgeCompletions,
    proxyHandler: (service, callerRunId, proxyRequest) => {
      const input = decodeSubagentProxyRequest(proxyRequest);
      if (Result.isFailure(input)) return Effect.fail(input.failure);
      return executeSubagentActionEffect(
        host.pi,
        { cwd: "/project", projectTrusted: true },
        input.success,
        () => {
          progress.observed += 1;
        },
        context,
        callerRunId,
      ).pipe(Effect.provideService(SubagentService, intercept(service)));
    },
  });
  return { ...fixture, progress };
};

const offerAwait = (
  control: FakeChildControl,
  requestId: string,
  args: { readonly runIds: ReadonlyArray<string>; readonly timeoutSeconds?: number },
) =>
  control.offerIpc({
    channel: "pi-subagents",
    type: "proxy_request",
    requestId,
    tool: "agent_await",
    argumentsJson: JSON.stringify({ until: "all_finished", ...args }),
  });

const proxiedResult = (control: FakeChildControl, requestId: string) => {
  const response = responseFor(control, requestId);
  expect(response?.ok).toBe(true);
  return decodeSubagentProxyResult(response?.payloadJson ?? "");
};

const nestedParentAndChild = (service: SubagentServiceContract) =>
  Effect.gen(function* () {
    const parent = yield* service.start(request({ name: "awaiting-parent" }));
    const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
    return { parent, child };
  });

describe("nested await timeouts", () => {
  it.effect("times out at the root with claims released, so the next await works", () => {
    const { fake, layer, progress } = nestedAwaitFixture();
    return withService(layer, function* (service) {
      const { child } = yield* nestedParentAndChild(service);
      const caller = fake.controls[0]!;
      offerAwait(caller, "timed", { runIds: [child.id], timeoutSeconds: 30 });
      yield* yieldUntil(() => progress.observed > 0);
      yield* TestClock.adjust("29 seconds");
      expect(responseFor(caller, "timed")).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* yieldUntil(() => responseFor(caller, "timed") !== undefined);
      const timedOut = proxiedResult(caller, "timed");
      expect(timedOut?.structuredContent).toMatchObject({
        outcome: "timed_out",
        cleanup: "confirmed",
      });
      expect(timedOut?.details).toMatchObject({ cancelled: true, timedOutSeconds: 30 });
      expect(timedOut?.details).not.toHaveProperty("cancellationCleanup");
      expect((yield* runView(service, child.id)).state).toBe("running");

      const observedBefore = progress.observed;
      offerAwait(caller, "again", { runIds: [child.id] });
      yield* yieldUntil(() => progress.observed > observedBefore);
      expect(responseFor(caller, "again")).toBeUndefined();
      fake.controls[1]!.settle("Report after the timeout.");
      yield* yieldUntil(() => responseFor(caller, "again") !== undefined);
      expect(proxiedResult(caller, "again")?.structuredContent).toMatchObject({
        outcome: "finished",
        targets: [{ runId: child.id, report: { status: "delivered" } }],
      });
    });
  });

  it.effect("finishes a delivery that the timeout finds in progress", () => {
    const consuming = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const { fake, layer, progress, notifications } = nestedAwaitFixture((service) => ({
      ...service,
      consumeCompletions: ((receipts) =>
        Deferred.succeed(consuming, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(service.consumeCompletions(receipts)),
        )) satisfies SubagentServiceContract["consumeCompletions"],
    }));
    return withService(layer, function* (service) {
      const { child } = yield* nestedParentAndChild(service);
      const caller = fake.controls[0]!;
      offerAwait(caller, "boundary", { runIds: [child.id], timeoutSeconds: 30 });
      yield* yieldUntil(() => progress.observed > 0);
      fake.controls[1]!.settle("Report at the boundary.");
      yield* Deferred.await(consuming);
      yield* TestClock.adjust("30 seconds");
      expect(responseFor(caller, "boundary")).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* yieldUntil(() => responseFor(caller, "boundary") !== undefined);
      expect(proxiedResult(caller, "boundary")?.structuredContent).toMatchObject({
        outcome: "finished",
        targets: [{ runId: child.id, report: { status: "delivered" } }],
      });
      // Delivered once, by the await: no notice repeats it.
      yield* TestClock.adjust("100 millis");
      expect(Arr.filter(caller.ipc, (message) => message.type === "proxy_notification")).toEqual(
        [],
      );
      expect(
        Arr.filter(notifications, (notification) => notification.type === "completed"),
      ).toEqual([]);
    });
  });

  it.effect("leaves an outcome the timeout beat unconsumed for the nested parent's notice", () => {
    const terminal = Deferred.makeUnsafe<void>();
    const { fake, layer, progress } = nestedAwaitFixture((service) => ({
      ...service,
      withAwaitTerminalObservations: ((ids, until, onUpdate, use, callerRunId) =>
        service.withAwaitTerminalObservations(
          ids,
          until,
          onUpdate,
          (observations, questions) =>
            Deferred.succeed(terminal, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.andThen(use(observations, questions)),
            ),
          callerRunId,
        )) satisfies SubagentServiceContract["withAwaitTerminalObservations"],
    }));
    return withService(layer, function* (service) {
      const { child } = yield* nestedParentAndChild(service);
      const caller = fake.controls[0]!;
      offerAwait(caller, "beaten", { runIds: [child.id], timeoutSeconds: 30 });
      yield* yieldUntil(() => progress.observed > 0);
      fake.controls[1]!.settle("Report the timeout beat.");
      yield* Deferred.await(terminal);
      yield* TestClock.adjust("30 seconds");
      yield* yieldUntil(() => responseFor(caller, "beaten") !== undefined);
      expect(proxiedResult(caller, "beaten")?.structuredContent).toMatchObject({
        outcome: "timed_out",
        cleanup: "confirmed",
        targets: [{ runId: child.id, report: { status: "deferred" } }],
      });
      // The released report reaches the nested parent as its own notice.
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() =>
        Arr.some(
          caller.ipc,
          (message) =>
            message.type === "proxy_notification" &&
            Fn.pipe(message.message, Str.includes(child.id)),
        ),
      );
    });
  });
});

describe("nested await messages", () => {
  it.effect("returns a nested parent's wait when its child messages it", () => {
    const { fake, layer, progress } = nestedAwaitFixture();
    return withService(layer, function* (service) {
      const { parent, child } = yield* nestedParentAndChild(service);
      const caller = fake.controls[0]!;
      offerAwait(caller, "messaged", { runIds: [child.id] });
      yield* yieldUntil(() => progress.observed > 0);
      yield* service.agentSend({ kind: "run", runId: child.id }, parent.id, "Which fixture?");
      yield* yieldUntil(() => responseFor(caller, "messaged") !== undefined);
      expect(proxiedResult(caller, "messaged")?.structuredContent).toMatchObject({
        outcome: "message",
        messagesFrom: [{ id: child.id, name: "child" }],
        targets: [{ runId: child.id, state: "running" }],
      });
      expect((yield* runView(service, child.id)).state).toBe("running");
    });
  });
});

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
      yield* yieldUntil(() =>
        Arr.every(attempts, ({ requestId }) => responseFor(caller, requestId) !== undefined),
      );
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
          if (Result.isFailure(input)) return Effect.fail(input.failure);
          return executeSubagentActionEffect(
            host.pi,
            { cwd: "/project", projectTrusted: true },
            input.success,
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
          Arr.some(
            notifications,
            (notification) =>
              notification.type === "completed" &&
              Arr.some(
                notification.runs,
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
        yield* yieldUntil(() =>
          Option.exists(Arr.last(projections), (projection) =>
            Arr.some(
              projection.runs,
              (run) => run.name === "owned-child" && run.state === "running",
            ),
          ),
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
      expect(Arr.filter(control.ipc, (message) => message.type === "proxy_response")).toEqual([]);
    }),
  );
});
