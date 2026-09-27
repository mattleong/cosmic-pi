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
import { captureExplicitPreferenceArgument } from "./boundary/host-cli.ts";
import { captureSelectedModel, captureThinkingLevel } from "./boundary/host-model.ts";
import { captureDirectorySession } from "./boundary/host-session.ts";
import { makeDirectoryModelsLayer } from "./layer.ts";
import {
  DirectoryModelPreferenceService,
  type DirectoryModelSessionInput,
} from "./preference/service.ts";

export function registerDirectoryModelsApplication(
  pi: ExtensionAPI,
  explicitPreference: boolean = captureExplicitPreferenceArgument(),
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
      warn(ctx, "Directory Models couldn't start");
    },
  });

  pi.on("session_start", (event, ctx) => {
    const captured = captureDirectorySession(event, ctx);
    if (!captured) {
      warn(ctx, "Directory Models isn't available in this session");
      return slot.shutdown();
    }
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          fresh: captured.fresh,
          explicitPreference,
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  const persist = (ctx: ExtensionContext) =>
    slot
      .run(DirectoryModelPreferenceService.use((service) => service.remember))
      .catch(() => warn(ctx, "Couldn't save the model for this directory"));

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
