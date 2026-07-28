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
} from "../layer.ts";
import { SubagentService } from "../run/service.ts";
import { registerSubagentManagerCommand } from "../settings/controller.ts";
import { registerSubagentTools, SUBAGENT_TOOL_NAMES } from "../tools/subagent.ts";

const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);

function deactivateSubagentTools(pi: ExtensionAPI): ReadonlyArray<string> {
  try {
    const active = pi.getActiveTools();
    const removed = active.filter((name) => SUBAGENT_TOOL_NAME_SET.has(name));
    pi.setActiveTools(active.filter((name) => !SUBAGENT_TOOL_NAME_SET.has(name)));
    return removed;
  } catch {
    // A stale host cannot turn registration cleanup into an unhandled callback error.
    return [];
  }
}

function reactivateSubagentTools(pi: ExtensionAPI, names: ReadonlyArray<string>): void {
  if (names.length === 0) return;
  try {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  } catch {
    // Recovery remains best effort when the host has already gone stale.
  }
}

function notifyActivationFailure(ctx: ExtensionContext, message: string): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  } catch {
    // A stale host UI cannot turn failed activation into an unhandled callback error.
  }
}

export function registerSubagentApplication(pi: ExtensionAPI): void {
  const bridge = makeSubagentProjectionBridge();
  const notify = makeHostNotifier(pi);
  let currentContext: ExtensionContext | undefined;
  let startupFailureTools: ReadonlyArray<string> = [];

  const slot = makePiSessionRuntimeSlot<
    ExtensionContext,
    SubagentApplication,
    never,
    SubagentRuntimeError
  >({
    makeRuntime: (ctx) =>
      makePiManagedRuntime(
        pi,
        makeSubagentLayer({
          cwd: ctx.cwd,
          agentDirectory: getAgentDir(),
          projectTrusted: isProjectTrusted(ctx),
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
    onActivated: (ctx) => {
      currentContext = ctx;
      bridge.setContext(ctx);
      reactivateSubagentTools(pi, startupFailureTools);
      startupFailureTools = [];
    },
    onDeactivated: () => {
      currentContext = undefined;
      notify.reset();
      bridge.clear();
    },
    onStartFailure: (ctx) => {
      startupFailureTools = deactivateSubagentTools(pi);
      notifyActivationFailure(
        ctx,
        "Subagents failed closed because configuration or runtime startup failed. Fix pi-subagents.json if present, inspect the logs, then run /reload.",
      );
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
          registerSubagentTools(pi, {
            run: (effect, signal) => run(effect, signal),
          });
        } catch {
          deactivateSubagentTools(pi);
          notifyActivationFailure(
            ctx,
            "Subagents failed to activate because tool registration failed.",
          );
          return slot.shutdown().then(() => undefined);
        }
        return slot.start(ctx, captured.signal);
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
    return slot.start(ctx, captured.signal).then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
