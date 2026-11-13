import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type { recordingExtensionHost } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { registerSubagentApplication } from "../../src/application/register.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "../../src/backend/model.ts";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import type {
  LocalPiChildIpcChannel,
  LocalPiChildIpcHandlers,
} from "../../src/boundary/local-pi-ipc.ts";
import * as ApplicationLayers from "../../src/layer.ts";
import { SubagentService, type SubagentServiceOptions } from "../../src/run/service.ts";
import { fakeWriterLeaseLayer, profileLayerFor } from "../run/fixtures/service-harness.ts";

/**
 * Registers the root application on `host` and starts `ctx`'s session, returning the layer options
 * it activated with. The scope's close shuts the session down, then restores the layer.
 */
export const activateRoot = (
  host: Pick<ReturnType<typeof recordingExtensionHost>, "pi" | "emit">,
  ctx: ExtensionContext,
  directory: string,
) =>
  Effect.gen(function* () {
    const captured: ApplicationLayers.SubagentLayerOptions[] = [];
    const makeLayer = ApplicationLayers.subagentApplicationLayer;
    const capture = vi
      .spyOn(ApplicationLayers, "subagentApplicationLayer")
      .mockImplementation((options) => {
        captured.push(options);
        return makeLayer(options);
      });
    registerSubagentApplication(host.pi, {
      loadSettings: () => Promise.resolve(),
      getAgentDirectory: () => directory,
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => Promise.resolve(host.emit("session_shutdown", ctx))).pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => capture.mockRestore())),
      ),
    );
    yield* Effect.tryPromise(() => Promise.resolve(host.emit("session_start", ctx)));
    const activation = captured[0];
    if (!activation) return yield* Effect.die("Root did not activate");
    return activation;
  });

/**
 * A child's IPC channel that offers each proxy request to its run's backend events, answering
 * whichever listener is attached when the response arrives.
 */
export const proxyIpcChannel = (offer: (event: BackendEvent) => void): LocalPiChildIpcChannel => {
  let listener: LocalPiChildIpcHandlers | undefined;
  return {
    listen: (handlers) => {
      listener = handlers;
      return () => {
        listener = undefined;
      };
    },
    sendContact: (contact) =>
      Effect.sync(() => {
        if (contact.type !== "proxy_request") return;
        offer({
          ...contact,
          respond: (ok, payloadJson) =>
            Effect.sync(() => {
              listener?.onControl({
                channel: "pi-subagents",
                type: "proxy_response",
                requestId: contact.requestId,
                ok,
                payloadJson,
              });
            }),
          questionnaireShown: () =>
            Effect.sync(() => {
              listener?.onControl({
                channel: "pi-subagents",
                type: "proxy_questionnaire_shown",
                requestId: contact.requestId,
              });
            }),
        });
      }),
  };
};

/**
 * A backend whose runs are inert live Pi children: each reports `run_started`, records its
 * steering input, and lets the test offer events on its authenticated channel.
 */
export const proxyBackend = (
  sessionFor: (launch: BackendLaunchRequest, index: number) => SessionManager = (launch) =>
    SessionManager.inMemory(launch.cwd),
) => {
  const launches: BackendLaunchRequest[] = [];
  const controls: Array<{
    readonly runId: string;
    readonly steered: string[];
    readonly offer: (event: BackendEvent) => void;
  }> = [];
  const driver: BackendDriver = {
    preflight: () => Effect.void,
    spawn: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<BackendEvent, Cause.Done>();
          const session = sessionFor(launch, launches.length);
          const control = {
            runId: launch.runId,
            steered: new Array<string>(),
            offer: (event: BackendEvent) => void Queue.offerUnsafe(events, event),
          };
          launches.push(launch);
          controls.push(control);
          return {
            events,
            awaitExit: Effect.never,
            acknowledge: () => {},
            terminate: () => Effect.void,
            cancelPending: () => {},
            controls: {
              initialize: Effect.succeed({
                model: launch.model,
                effort: launch.effort,
                sessionId: session.getSessionId(),
                sessionFile: session.getSessionFile(),
              }),
              start: (_message: string, assignmentEpoch: number) =>
                Effect.sync(() => control.offer({ type: "run_started", assignmentEpoch })),
              steer: (message: string) => Effect.sync(() => void control.steered.push(message)),
              interrupt: Effect.void,
              reply: () => Effect.void,
              notifyPeers: () => Effect.void,
            },
          };
        }),
        (handle) => Effect.sync(() => Queue.endUnsafe(handle.events)),
      ),
  };
  return { launches, controls, layer: Layer.succeed(SubagentBackendRegistry, driver) };
};

/** The run service over a proxy backend, as a root session composes it. */
export const proxyServiceLayer = (
  options: SubagentServiceOptions,
  backend: ReturnType<typeof proxyBackend>,
  profiles = profileLayerFor({}),
) =>
  SubagentService.layer(options).pipe(
    Layer.provideMerge(backend.layer),
    Layer.provideMerge(profiles),
    Layer.provide(fakeWriterLeaseLayer()),
  );
