import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { loadCodePreviewSettings } from "pi-code-previews";
import {
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { makeProjectionBridge } from "./boundary/host-ui.ts";
import { BackgroundTerminalConfigStore } from "./config/store.ts";
import type { BackgroundTerminalProjection } from "./job/model.ts";
import { BackgroundTerminalService } from "./job/service.ts";
import {
  makeBackgroundTerminalLayer,
  type BackgroundTerminalApplication,
  type BackgroundTerminalRuntimeError,
  type BackgroundTerminalSessionInput,
} from "./layer.ts";
import { registerProcessManagerCommand } from "./settings/controller.ts";
import { registerBackgroundTerminalTool } from "./tools/background-terminal.ts";

export interface BackgroundTerminalsApplicationBoundaries {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
  ) => ReturnType<typeof loadCodePreviewSettings> | Promise<void>;
}

const LIVE_APPLICATION_BOUNDARIES: BackgroundTerminalsApplicationBoundaries = {
  loadSettings: loadCodePreviewSettings,
};

export function registerBackgroundTerminalsApplication(
  pi: ExtensionAPI,
  boundaries: BackgroundTerminalsApplicationBoundaries = LIVE_APPLICATION_BOUNDARIES,
): void {
  const bridge = makeProjectionBridge(pi.events);
  let preparationGeneration = 0;

  const slot = makePiSessionRuntimeSlot<
    BackgroundTerminalSessionInput,
    BackgroundTerminalApplication,
    never,
    BackgroundTerminalRuntimeError,
    { readonly showFooterStatus: boolean; readonly projection: BackgroundTerminalProjection }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeBackgroundTerminalLayer(input, {
          publish: bridge.publish,
        }),
        { agentDirectory: getAgentDir, packageName: "pi-background-terminals" },
      ),
    startup: () =>
      Effect.gen(function* () {
        const config = yield* BackgroundTerminalConfigStore;
        const service = yield* BackgroundTerminalService;
        return {
          showFooterStatus: config.showFooterStatus,
          projection: yield* service.projection,
        };
      }),
    onActivated: ({ ctx }, _token, prepared) => {
      bridge.setFooterEnabled(prepared.showFooterStatus);
      bridge.publish(prepared.projection);
      bridge.setContext(ctx);
    },
    onDeactivated: () => bridge.clear(),
  });

  const run = <A, E>(
    effect: Effect.Effect<A, E, BackgroundTerminalApplication>,
    signal?: AbortSignal,
  ) => slot.run(effect, signal);

  registerProcessManagerCommand(pi, bridge, {
    stop: (id) =>
      run(BackgroundTerminalService.use((service) => service.stop(id))).then(() => undefined),
    clear: () =>
      run(BackgroundTerminalService.use((service) => service.clear)).then(() => undefined),
  });

  const prepareActivation = (ctx: ExtensionContext): Promise<void> => {
    const generation = ++preparationGeneration;
    bridge.clear();
    // Replacement begins before the settings boundary so no tool call can target the prior
    // session while a newer activation is still being prepared.
    const shutdown = slot.shutdown();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return shutdown.then(() => undefined);
    if (captured.aborted) return shutdown.then(() => undefined);
    const preparationAborted = () => {
      try {
        return captured.signal?.aborted === true;
      } catch {
        return true;
      }
    };
    let removePreparationAbort: () => void = () => undefined;
    if (captured.signal) {
      try {
        const invalidatePreparation = () => {
          if (generation === preparationGeneration) ++preparationGeneration;
        };
        captured.signal.addEventListener("abort", invalidatePreparation, { once: true });
        removePreparationAbort = () => {
          try {
            captured.signal?.removeEventListener("abort", invalidatePreparation);
          } catch {
            // A stale host signal cannot escape lifecycle cleanup.
          }
        };
        if (preparationAborted()) invalidatePreparation();
      } catch {
        return shutdown.then(() => undefined);
      }
    }
    const projectTrusted = isProjectTrusted(ctx);
    const settings = Promise.resolve()
      .then(() => Promise.resolve(boundaries.loadSettings(captured.cwd, projectTrusted)))
      .catch(() => undefined);
    return Promise.all([shutdown, settings])
      .then(() => {
        if (generation !== preparationGeneration || preparationAborted()) return undefined;
        registerBackgroundTerminalTool(pi, { run });
        if (generation !== preparationGeneration || preparationAborted()) return undefined;
        return slot.start(
          {
            ctx,
            cwd: captured.cwd,
            projectTrusted,
          },
          captured.signal,
        );
      })
      .then(() => undefined)
      .finally(removePreparationAbort);
  };

  pi.on("session_start", (_event, ctx) => prepareActivation(ctx));

  pi.on("turn_end", (_event, ctx) => {
    if (slot.isActive()) bridge.setContext(ctx);
  });

  pi.on("session_shutdown", () => {
    ++preparationGeneration;
    bridge.clear();
    return slot.shutdown();
  });
}
