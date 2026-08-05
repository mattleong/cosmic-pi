import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { loadCodePreviewSettings } from "pi-code-previews";
import {
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
import { AskUserService } from "./questionnaire/service.ts";
import { registerAskUserTool } from "./tools/ask-user.ts";

export function registerAskUserApplication(pi: ExtensionAPI): void {
  const bridge = makeAskUserDialogBridge();
  let startupGeneration = 0;

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
    startup: () => AskUserService.use(() => Effect.void),
    onActivated: ({ ctx }) => bridge.setContext(ctx),
    onDeactivated: () => {
      bridge.clear();
      bridge.setContext(undefined);
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, AskUserApplication>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  registerAskUserCommands(pi, bridge);

  pi.on("session_start", (_event, ctx) => {
    const generation = ++startupGeneration;
    bridge.clear();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || !ctx.hasUI) {
      bridge.setContext(undefined);
      return slot.shutdown().then(() => undefined);
    }
    const projectTrusted = isProjectTrusted(ctx);
    return Promise.all([
      slot.shutdown(),
      loadCodePreviewSettings(captured.cwd, projectTrusted).catch(() => undefined),
    ])
      .then(() => {
        if (generation !== startupGeneration || captured.signal?.aborted) return undefined;
        return slot.start(
          {
            ctx,
            cwd: captured.cwd,
            projectTrusted,
          },
          captured.signal,
        );
      })
      .then((token) => {
        if (token === undefined || generation !== startupGeneration || !slot.isCurrent(token))
          return;
        registerAskUserTool(pi, { run });
      });
  });

  pi.on("session_shutdown", () => {
    startupGeneration += 1;
    bridge.clear();
    bridge.setContext(undefined);
    return slot.shutdown();
  });
}
