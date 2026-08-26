/** Per-directory model preferences implemented as an Effect-managed Pi session runtime. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import { captureExplicitModelArgument } from "./boundary/host-cli.ts";
import { captureSelectedModel, captureThinkingLevel } from "./boundary/host-model.ts";
import { captureDirectorySession } from "./boundary/host-session.ts";
import { makeDirectoryModelsLayer } from "./layer.ts";
import {
  DirectoryModelPreferenceService,
  type DirectoryModelSessionInput,
} from "./preference/service.ts";

export function registerDirectoryModelsApplication(
  pi: ExtensionAPI,
  hasExplicitModel: () => boolean = captureExplicitModelArgument,
): void {
  const warn = (ctx: ExtensionContext, message: string) =>
    notifyAtHostBoundary(ctx, message, "warning");

  const slot = makePiSessionRuntimeSlot({
    makeRuntime: (input: DirectoryModelSessionInput) =>
      makePiManagedRuntime(
        pi,
        makeDirectoryModelsLayer(input, (message) => warn(input.ctx, message)),
        { agentDirectory: getAgentDir, packageName: "pi-directory-models" },
      ),
    startup: () => DirectoryModelPreferenceService.use((service) => service.initialize),
    onStartFailure: ({ ctx }) => {
      warn(ctx, "Directory model preferences failed to start.");
    },
  });

  pi.on("session_start", (event, ctx) => {
    const captured = captureDirectorySession(event, ctx);
    if (!captured) {
      warn(ctx, "Directory model preferences are unavailable for this session.");
      return slot.shutdown().then(() => undefined);
    }
    let explicitModel = false;
    try {
      explicitModel = hasExplicitModel();
    } catch {
      // Host CLI inspection is best effort; ordinary directory preference behavior remains safe.
    }
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          fresh: captured.fresh,
          explicitModel,
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  const persist = (ctx: ExtensionContext) =>
    slot
      .run(DirectoryModelPreferenceService.use((service) => service.remember))
      .catch(() => warn(ctx, "Unable to save the directory preference."));

  pi.on("model_select", (event, ctx) => {
    if (!slot.isActive()) return;
    if (event.source === "restore") return;
    if (!captureSelectedModel(event.model)) return;
    return persist(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (!slot.isActive()) return;
    if (!captureThinkingLevel(event.level)) return;
    return persist(ctx);
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
