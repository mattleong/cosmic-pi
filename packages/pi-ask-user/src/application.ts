import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { loadCodePreviewSettings, type CodePreviewSettings } from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { registerAskUserCommands } from "./boundary/host-commands.ts";
import { makeAskUserDialogBridge } from "./boundary/host-ui.ts";
import {
  makeAskUserLayer,
  type AskUserApplication,
  type AskUserRuntimeError,
  type AskUserSessionInput,
} from "./layer.ts";
import { AskUserRuntimeClosedError } from "./questionnaire/errors.ts";
import { AskUserService } from "./questionnaire/service.ts";
import { registerAskUserTool } from "./tools/ask-user.ts";

export interface AskUserApplicationDependencies {
  readonly loadPreviewSettings?: (
    projectCwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
  readonly startupEffect?: Effect.Effect<void>;
}

export function registerAskUserApplication(pi: ExtensionAPI): void {
  askUserWithDependencies(pi, {});
}

/** Internal seam for lifecycle and startup-order tests. */
export function askUserWithDependencies(
  pi: ExtensionAPI,
  dependencies: AskUserApplicationDependencies,
): void {
  const bridge = makeAskUserDialogBridge();
  const loadPreviewSettings = dependencies.loadPreviewSettings ?? loadCodePreviewSettings;
  const startupEffect = dependencies.startupEffect ?? Effect.void;
  let sessionActive = false;

  const slot = makePiSessionRuntimeSlot<
    AskUserSessionInput,
    AskUserApplication,
    never,
    AskUserRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(pi, makeAskUserLayer(input, bridge), {
        agentDirectory: getAgentDir,
        packageName: "pi-ask-user",
      }),
    startup: ({ cwd, projectTrusted }) =>
      bestEffortHostBootstrap("pi-ask-user.preview-settings", (signal) =>
        loadPreviewSettings(cwd, projectTrusted, signal),
      ).pipe(Effect.andThen(startupEffect), Effect.andThen(AskUserService.use(() => Effect.void))),
    onActivated: ({ ctx }) => {
      sessionActive = true;
      bridge.setContext(ctx);
      registerAskUserTool(pi, {
        run: (effect, signal) =>
          sessionActive
            ? slot.run(effect, signal)
            : Promise.reject(
                new AskUserRuntimeClosedError({
                  message: "The ask-user session runtime is not active.",
                }),
              ),
      });
    },
    onDeactivated: () => {
      sessionActive = false;
      bridge.clear();
      bridge.setContext(undefined);
    },
  });

  registerAskUserCommands(pi, bridge);

  pi.on("session_start", (_event, ctx) => {
    bridge.clear();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || !ctx.hasUI) {
      bridge.setContext(undefined);
      return slot.shutdown().then(() => undefined);
    }
    const projectTrusted = isProjectTrusted(ctx);
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted,
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => {
    bridge.clear();
    bridge.setContext(undefined);
    return slot.shutdown();
  });
}
