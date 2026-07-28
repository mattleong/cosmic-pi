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
import { SubagentConfigStore } from "../config/store.ts";
import {
  makeSubagentLayer,
  type SubagentApplication,
  type SubagentRuntimeError,
} from "../layer.ts";
import { SubagentService } from "../run/service.ts";
import { registerSubagentManagerCommand } from "../settings/controller.ts";
import { registerSubagentTools, SUBAGENT_TOOL_NAMES } from "../tools/subagent.ts";

const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);

export interface SubagentApplicationBoundaries {
  readonly loadSettings: (cwd: string, projectTrusted: boolean) => Promise<unknown>;
}

const LIVE_APPLICATION_BOUNDARIES: SubagentApplicationBoundaries = {
  loadSettings: loadCodePreviewSettings,
};

interface CapturedActivation {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDirectory: string;
}

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

export function registerSubagentApplication(
  pi: ExtensionAPI,
  boundaries: SubagentApplicationBoundaries = LIVE_APPLICATION_BOUNDARIES,
): void {
  const bridge = makeSubagentProjectionBridge();
  const notify = makeHostNotifier(pi);
  let currentContext: ExtensionContext | undefined;
  let currentActivation: CapturedActivation | undefined;
  let startupFailureTools: ReadonlyArray<string> = [];
  let preparationGeneration = 0;
  let hasRegisteredTools = false;

  const rememberDisabledTools = (names: ReadonlyArray<string>): void => {
    startupFailureTools = [...new Set([...startupFailureTools, ...names])];
  };

  const slot = makePiSessionRuntimeSlot<
    CapturedActivation,
    SubagentApplication,
    never,
    SubagentRuntimeError
  >({
    makeRuntime: (activation) =>
      makePiManagedRuntime(
        pi,
        makeSubagentLayer({
          cwd: activation.cwd,
          agentDirectory: activation.agentDirectory,
          projectTrusted: activation.projectTrusted,
          publish: bridge.publish,
          notify,
        }),
        { agentDirectory: () => activation.agentDirectory, packageName: "pi-subagents" },
      ),
    startup: () =>
      SubagentService.use((service) => service.projection).pipe(
        Effect.tap((projection) => Effect.sync(() => bridge.publish(projection))),
        Effect.asVoid,
      ),
    onActivated: (activation) => {
      currentContext = activation.ctx;
      currentActivation = activation;
      bridge.setContext(activation.ctx);
      reactivateSubagentTools(pi, startupFailureTools);
      startupFailureTools = [];
    },
    onDeactivated: () => {
      rememberDisabledTools(deactivateSubagentTools(pi));
      currentContext = undefined;
      currentActivation = undefined;
      notify.reset();
      bridge.clear();
    },
    onStartFailure: (activation) => {
      rememberDisabledTools(deactivateSubagentTools(pi));
      notifyActivationFailure(
        activation.ctx,
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
    inspectProfiles: (projectTrusted) => {
      const activation = currentActivation;
      if (!activation)
        return Promise.reject(new Error("Subagents are not active; run /reload and try again."));
      return run(
        Effect.flatMap(SubagentConfigStore, (store) =>
          store.inspect(activation.cwd, activation.agentDirectory, projectTrusted),
        ),
      );
    },
    patchProfile: (patch) => {
      const activation = currentActivation;
      if (!activation)
        return Promise.reject(new Error("Subagents are not active; run /reload and try again."));
      return run(
        Effect.flatMap(SubagentConfigStore, (store) =>
          store.patchProfile(activation.cwd, activation.agentDirectory, patch),
        ),
      );
    },
  });

  const prepareActivation = (ctx: ExtensionContext): Promise<void> => {
    const generation = ++preparationGeneration;
    bridge.clear();
    // No registered Subagents tool may target the inactive slot while capture, settings, or runtime
    // replacement is pending. Preserve only names that were active before deactivation.
    rememberDisabledTools(deactivateSubagentTools(pi));
    const shutdown = slot.shutdown();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return shutdown.then(() => undefined);
    if (captured.aborted)
      return shutdown.then(() => {
        if (generation === preparationGeneration)
          notifyActivationFailure(
            ctx,
            "Subagents did not activate because the session is aborted.",
          );
      });
    const projectTrusted = isProjectTrusted(ctx);
    let agentDirectory: string;
    try {
      agentDirectory = getAgentDir();
    } catch {
      return shutdown.then(() => {
        if (generation === preparationGeneration)
          notifyActivationFailure(ctx, "Subagents failed to capture the session environment.");
      });
    }
    const activation: CapturedActivation = {
      ctx,
      cwd: captured.cwd,
      projectTrusted,
      agentDirectory,
    };
    const settings = Promise.resolve()
      .then(() => boundaries.loadSettings(activation.cwd, activation.projectTrusted))
      .catch(() => undefined);
    return Promise.all([shutdown, settings])
      .then(() => {
        if (generation !== preparationGeneration) return undefined;
        try {
          registerSubagentTools(pi, {
            environment: {
              cwd: activation.cwd,
              projectTrusted: activation.projectTrusted,
            },
            run: (effect, signal) => run(effect, signal),
          });
          const activatedByRegistration = deactivateSubagentTools(pi);
          if (!hasRegisteredTools) rememberDisabledTools(activatedByRegistration);
          hasRegisteredTools = true;
        } catch {
          rememberDisabledTools(deactivateSubagentTools(pi));
          notifyActivationFailure(
            activation.ctx,
            "Subagents failed to activate because tool registration failed.",
          );
          return slot.shutdown().then(() => undefined);
        }
        if (generation !== preparationGeneration) return undefined;
        return slot.start(activation, captured.signal).then(() => undefined);
      })
      .then(() => undefined);
  };

  pi.on("session_start", (_event, ctx) => prepareActivation(ctx));

  pi.on("turn_end", (_event, ctx) => {
    if (!currentContext) return;
    currentContext = ctx;
    bridge.setContext(ctx);
  });

  pi.on("session_tree", (_event, ctx) => prepareActivation(ctx));

  pi.on("session_shutdown", () => {
    ++preparationGeneration;
    rememberDisabledTools(deactivateSubagentTools(pi));
    bridge.clear();
    return slot.shutdown();
  });
}
