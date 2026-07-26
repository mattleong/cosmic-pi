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
import { makeHostNotifier } from "../boundary/host-notifier.ts";
import { makeSubagentProjectionBridge } from "../boundary/host-ui.ts";
import {
  makeSubagentLayer,
  type SubagentApplication,
  type SubagentRuntimeError,
  type SubagentSessionInput,
} from "../layer.ts";
import { SubagentService } from "../run/service.ts";
import { registerSubagentManagerCommand } from "../settings/controller.ts";
import { registerSubagentTool } from "../tools/subagent.ts";

function notifyToolRegistrationFailure(ctx: ExtensionContext): void {
  try {
    if (ctx.hasUI)
      ctx.ui.notify("Subagents failed to activate because tool registration failed.", "error");
  } catch {
    // A stale host UI cannot turn failed activation into an unhandled callback error.
  }
}

export function registerSubagentApplication(pi: ExtensionAPI): void {
  const bridge = makeSubagentProjectionBridge();
  const notify = makeHostNotifier(pi);
  let currentContext: ExtensionContext | undefined;

  const slot = makePiSessionRuntimeSlot<
    SubagentSessionInput,
    SubagentApplication,
    never,
    SubagentRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeSubagentLayer(input, {
          publish: bridge.publish,
          notify,
        }),
        { agentDirectory: getAgentDir, packageName: "pi-subagents" },
      ),
    startup: () =>
      SubagentService.use((service) => service.projection).pipe(
        Effect.tap((projection) => Effect.sync(() => bridge.publish(projection))),
        Effect.asVoid,
      ),
    onActivated: ({ ctx }) => {
      currentContext = ctx;
      bridge.setContext(ctx);
    },
    onDeactivated: () => {
      currentContext = undefined;
      notify.reset();
      bridge.clear();
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, SubagentApplication>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  registerSubagentManagerCommand(pi, bridge, {
    stop: (id) => run(SubagentService.use((service) => service.stop(id))).then(() => undefined),
    interrupt: (id) =>
      run(SubagentService.use((service) => service.interrupt(id))).then(() => undefined),
    resume: (id, message) =>
      run(SubagentService.use((service) => service.resume(id, message))).then(() => undefined),
    send: (id, message) =>
      run(SubagentService.use((service) => service.send(id, message))).then(() => undefined),
    reply: (id, message) =>
      run(SubagentService.use((service) => service.reply(id, message))).then(() => undefined),
    rename: (id, name) =>
      run(SubagentService.use((service) => service.rename(id, name))).then(() => undefined),
  });

  pi.on("session_start", (_event, ctx) => {
    bridge.clear();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return slot.shutdown().then(() => undefined);
    const projectTrusted = isProjectTrusted(ctx);
    return loadCodePreviewSettings(captured.cwd, projectTrusted)
      .catch(() => undefined)
      .then(() => {
        try {
          registerSubagentTool(pi, {
            run: (effect, signal) => run(effect, signal),
          });
        } catch {
          notifyToolRegistrationFailure(ctx);
          return slot.shutdown().then(() => undefined);
        }
        return slot.start(
          {
            ctx,
            cwd: captured.cwd,
            projectTrusted,
          },
          captured.signal,
        );
      })
      .then(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!currentContext) return;
    currentContext = ctx;
    bridge.setContext(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
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

  pi.on("session_shutdown", () => slot.shutdown());
}
