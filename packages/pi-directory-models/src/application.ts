import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import { makePiSessionRuntimeSlot } from "pi-cosmic-core/runtime/session-runtime";
import { notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { nodePath } from "pi-cosmic-core/platform/node-builtins";
import { captureExplicitPreferenceArgument } from "./boundary/host-cli.ts";
import { captureSelectedModel, directoryModelHost } from "./boundary/host-model.ts";
import { captureDirectorySession } from "./boundary/host-session.ts";
import { decodeThinkingLevel } from "./config/schema.ts";
import { STORE_DIRECTORY } from "./config/store.ts";
import { directoryModelsLayer } from "./layer.ts";
import {
  DirectoryModelPreferenceService,
  storeWriteWarning,
  type DirectoryModelSessionInput,
} from "./preference/service.ts";

const warn = (ctx: ExtensionContext, message: string) =>
  notifyAtHostBoundary(ctx, message, "warning");

const RETRY_HINT = "Start a new session with /new to try again";

interface DirectoryModelSession extends DirectoryModelSessionInput {
  readonly ctx: ExtensionContext;
}

export function registerDirectoryModelsApplication(
  pi: ExtensionAPI,
  explicitPreference: boolean = captureExplicitPreferenceArgument(),
): void {
  const slot = makePiSessionRuntimeSlot({
    makeRuntime: (input: DirectoryModelSession) => {
      // Start has already advanced the epoch, so this authority retires with this runtime.
      // Runtime disposal follows retirement asynchronously; the check keeps late warnings out.
      const isCurrent = slot.captureAuthority();
      return makePiManagedRuntime(
        pi,
        directoryModelsLayer(input, (message, level) => {
          if (isCurrent()) notifyAtHostBoundary(input.ctx, message, level);
        }),
        { agentDirectory: getAgentDir, packageName: "pi-directory-models" },
      );
    },
    startup: () => DirectoryModelPreferenceService.use((service) => service.initialize),
    onStartFailure: ({ ctx }) => {
      warn(
        ctx,
        `Directory Models couldn't start, so models aren't restored or saved\n${RETRY_HINT}`,
      );
    },
  });

  pi.on("session_start", (event, ctx) => {
    const captured = captureDirectorySession(event, ctx);
    if (!captured) {
      warn(
        ctx,
        `Directory Models couldn't read this session, so models aren't restored or saved\n${RETRY_HINT}`,
      );
      return slot.shutdown();
    }
    return slot
      .start(
        {
          ctx,
          models: directoryModelHost(ctx),
          cwd: captured.cwd,
          fresh: captured.fresh,
          explicitPreference,
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  const persist = (ctx: ExtensionContext) => {
    const isCurrent = slot.captureAuthority();
    return slot
      .run(DirectoryModelPreferenceService.use((service) => service.remember))
      .catch(() => {
        if (isCurrent())
          warn(ctx, storeWriteWarning(nodePath.join(getAgentDir(), STORE_DIRECTORY), ctx.cwd));
      });
  };

  pi.on("model_select", (event, ctx) => {
    if (!slot.isActive() || event.source === "restore" || !captureSelectedModel(event.model))
      return undefined;
    return persist(ctx);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    if (!slot.isActive() || !decodeThinkingLevel(event.level)) return undefined;
    return persist(ctx);
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
