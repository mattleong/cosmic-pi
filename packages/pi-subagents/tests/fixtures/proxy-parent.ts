import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { recordingExtensionHost } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { registerSubagentApplication } from "../../src/application/register.ts";
import type { BackendEvent } from "../../src/backend/model.ts";
import type {
  LocalPiChildIpcChannel,
  LocalPiChildIpcHandlers,
} from "../../src/boundary/local-pi-ipc.ts";
import * as ApplicationLayers from "../../src/layer.ts";

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
        });
      }),
  };
};
