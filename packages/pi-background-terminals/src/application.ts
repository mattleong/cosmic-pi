import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { makeProjectionBridge } from "./boundary/host-ui.ts";
import { BackgroundTerminalConfigStore } from "./config/store.ts";
import { BackgroundTerminalService } from "./job/service.ts";
import {
  makeBackgroundTerminalLayer,
  type BackgroundTerminalApplication,
  type BackgroundTerminalRuntimeError,
  type BackgroundTerminalSessionInput,
} from "./layer.ts";
import { registerProcessManagerCommand } from "./settings/controller.ts";
import { registerBackgroundTerminalTool } from "./tools/background-terminal.ts";

export function registerBackgroundTerminalsApplication(pi: ExtensionAPI): void {
  const bridge = makeProjectionBridge();
  let currentContext: ExtensionContext | undefined;

  const slot = makePiSessionRuntimeSlot<
    BackgroundTerminalSessionInput,
    BackgroundTerminalApplication,
    never,
    BackgroundTerminalRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeBackgroundTerminalLayer(input, {
          publish: bridge.publish,
        }),
      ),
    startup: () =>
      Effect.gen(function* () {
        const config = yield* BackgroundTerminalConfigStore;
        const service = yield* BackgroundTerminalService;
        bridge.setFooterEnabled(config.showFooterStatus);
        bridge.publish(yield* service.projection);
      }),
    onActivated: ({ ctx }) => {
      currentContext = ctx;
      bridge.setContext(ctx);
    },
    onDeactivated: () => {
      currentContext = undefined;
      bridge.clear();
    },
  });

  const run = <A, E>(
    effect: Effect.Effect<A, E, BackgroundTerminalApplication>,
    signal?: AbortSignal,
  ) => slot.run(effect, signal);

  registerBackgroundTerminalTool(pi, { run });
  registerProcessManagerCommand(pi, bridge, {
    stop: (id) =>
      run(BackgroundTerminalService.use((service) => service.stop(id))).then(() => undefined),
    clear: () =>
      run(BackgroundTerminalService.use((service) => service.clear)).then(() => undefined),
  });

  pi.on("session_start", (_event, ctx) => {
    bridge.clear();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return slot.shutdown().then(() => undefined);
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted: isProjectTrusted(ctx),
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (currentContext) {
      currentContext = ctx;
      bridge.setContext(ctx);
    }
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
