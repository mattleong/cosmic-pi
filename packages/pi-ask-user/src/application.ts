import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCodePreviewSettings, type CodePreviewSettings } from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
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

type PreviewSettingsLoader = (
  projectCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
) => PromiseLike<CodePreviewSettings | void>;

/** Internal seam for lifecycle and startup-order tests. */
export function askUserWithDependencies(
  pi: ExtensionAPI,
  loadPreviewSettings: PreviewSettingsLoader = loadCodePreviewSettings,
): void {
  const bridge = makeAskUserDialogBridge();

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
      ),
    onActivated: ({ ctx }, token) => {
      bridge.setContext(ctx);
      registerAskUserTool(pi, (request, signal) =>
        slot.isCurrent(token)
          ? slot.run(
              AskUserService.use((service) => service.ask(request)),
              signal,
            )
          : Promise.reject(
              new AskUserRuntimeClosedError({
                message: "The ask-user session runtime is not active.",
              }),
            ),
      );
    },
    onDeactivated: () => {
      bridge.clear();
      bridge.setContext(undefined);
    },
  });

  pi.registerCommand("ask-user", {
    description: "Resume the active hidden questionnaire",
    handler: (_args, ctx) => {
      if (!bridge.resume()) notifyAtHostBoundary(ctx, "No hidden questionnaire is active.", "info");
      return Promise.resolve();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || !ctx.hasUI) return slot.shutdown();
    return slot
      .start({ ctx, cwd: captured.cwd, projectTrusted: isProjectTrusted(ctx) }, captured.signal)
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
