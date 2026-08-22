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
import { NativeModelCatalog } from "../boundary/native-model-catalog.ts";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { SubagentConfigStore } from "../config/store.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileOverrideSeed } from "../profiles/session-overrides.ts";
import {
  makeSubagentLayer,
  type SubagentApplication,
  type SubagentRuntimeError,
} from "../layer.ts";
import type { SubagentProjection } from "../run/model.ts";
import { SubagentService } from "../run/service.ts";
import { registerSubagentManagerCommand } from "../settings/controller.ts";
import { registerSubagentTools, SUBAGENT_TOOL_NAMES } from "../tools/subagent.ts";
import { makeProfileOverrideHandoff } from "./profile-override-handoff.ts";
import { makeProfileReloadHandoff, profileReloadSessionKey } from "./profile-reload-handoff.ts";

const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);

export interface SubagentApplicationBoundaries {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
  ) => ReturnType<typeof loadCodePreviewSettings> | Promise<void>;
  readonly getAgentDirectory?: (() => string) | undefined;
}

const LIVE_APPLICATION_BOUNDARIES: SubagentApplicationBoundaries = {
  loadSettings: loadCodePreviewSettings,
  getAgentDirectory: getAgentDir,
};

interface CapturedActivation {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDirectory: string;
  readonly generation: number;
  readonly sessionKey?: string | undefined;
  readonly reloadHandoffKey?: string | undefined;
  readonly sessionBaseConfig?: ResolvedSubagentConfig | undefined;
  readonly sessionOverrides: SessionProfileOverrideSeed;
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
  const bridge = makeSubagentProjectionBridge(pi.events);
  const notify = makeHostNotifier(pi);
  let currentContext: ExtensionContext | undefined;
  let currentActivation: CapturedActivation | undefined;
  let startupFailureTools: ReadonlyArray<string> = [];
  let preparationGeneration = 0;
  let activeProfileGeneration = -1;
  const profileOverrideHandoff = makeProfileOverrideHandoff();
  const profileReloadHandoff = makeProfileReloadHandoff();
  let hasRegisteredTools = false;

  const rememberDisabledTools = (names: ReadonlyArray<string>): void => {
    startupFailureTools = [...new Set([...startupFailureTools, ...names])];
  };

  const slot = makePiSessionRuntimeSlot<
    CapturedActivation,
    SubagentApplication,
    never,
    SubagentRuntimeError,
    SubagentProjection
  >({
    makeRuntime: (activation) =>
      makePiManagedRuntime(
        pi,
        makeSubagentLayer(
          (() => {
            const baseResult = {
              cwd: activation.cwd,
              agentDirectory: activation.agentDirectory,
              projectTrusted: activation.projectTrusted,
            };
            const withSessionBaseConfig = activation.sessionBaseConfig
              ? { ...baseResult, sessionBaseConfig: activation.sessionBaseConfig }
              : baseResult;
            const withPublishSessionBaseConfigAndAdditionalFields = {
              ...withSessionBaseConfig,
              publishSessionBaseConfig: (config: ResolvedSubagentConfig) =>
                profileOverrideHandoff.publishBaseConfig(
                  activation.generation,
                  activeProfileGeneration,
                  config,
                ),
              initialSessionOverrides: activation.sessionOverrides,
              publishSessionOverrides: (seed: SessionProfileOverrideSeed) =>
                profileOverrideHandoff.publish(
                  activation.generation,
                  activeProfileGeneration,
                  seed,
                ),
              publish: bridge.publish,
              notify,
            };
            return withPublishSessionBaseConfigAndAdditionalFields;
          })(),
        ),
        { agentDirectory: () => activation.agentDirectory, packageName: "pi-subagents" },
      ),
    startup: () => SubagentService.use((service) => service.projection),
    onActivated: (activation, _token, projection) => {
      currentContext = activation.ctx;
      bridge.publish(projection);
      currentActivation = activation;
      if (activation.reloadHandoffKey) profileReloadHandoff.clear(activation.reloadHandoffKey);
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
    isAvailable: () => currentActivation !== undefined,
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
        Effect.gen(function* () {
          const store = yield* SubagentConfigStore;
          const profiles = yield* SubagentProfileService;
          const persistent = yield* store.inspect(
            activation.cwd,
            activation.agentDirectory,
            projectTrusted,
          );
          const session = yield* profiles.capture;
          return { ...persistent, session };
        }),
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
    patchSessionProfile: (patch) =>
      run(SubagentProfileService.use((profiles) => profiles.patchSessionProfile(patch))).then(
        () => undefined,
      ),
    clearSessionProfiles: (expectedRevision) =>
      run(
        SubagentProfileService.use((profiles) => profiles.clearSessionProfiles(expectedRevision)),
      ).then(() => undefined),
    listNativeModels: (runtime, signal) => {
      const activation = currentActivation;
      if (!activation)
        return Promise.reject(new Error("Subagents are not active; run /reload and try again."));
      return run(
        Effect.flatMap(NativeModelCatalog, (catalog) => catalog.list(runtime, activation.cwd)),
        signal,
      );
    },
  });

  const prepareActivation = (
    ctx: ExtensionContext,
    preserveSessionOverrides: boolean,
    restoredReload?:
      | {
          readonly sessionKey: string;
          readonly seed: SessionProfileOverrideSeed;
        }
      | undefined,
  ): Promise<void> => {
    if (!preserveSessionOverrides) {
      activeProfileGeneration = -1;
      profileOverrideHandoff.clear();
    }
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
      agentDirectory = (boundaries.getAgentDirectory ?? getAgentDir)();
    } catch {
      return shutdown.then(() => {
        if (generation === preparationGeneration)
          notifyActivationFailure(ctx, "Subagents failed to capture the session environment.");
      });
    }
    const settings = Promise.resolve()
      .then(() =>
        Promise.resolve(boundaries.loadSettings(captured.cwd, projectTrusted)).then(
          () => undefined,
        ),
      )
      .catch(() => undefined);
    return Promise.all([shutdown, settings])
      .then(() => {
        if (generation !== preparationGeneration) return undefined;
        const sessionBaseConfig = profileOverrideHandoff.captureBaseConfig();
        const sessionKey = profileReloadSessionKey(ctx);
        if (restoredReload)
          profileOverrideHandoff.publish(generation, generation, restoredReload.seed);
        const activation: CapturedActivation = (() => {
          const baseResult = {
            ctx,
            cwd: captured.cwd,
            projectTrusted,
            agentDirectory,
            generation,
          };
          const withSessionKey = sessionKey ? { ...baseResult, sessionKey } : baseResult;
          const withReloadHandoffKey = restoredReload
            ? { ...withSessionKey, reloadHandoffKey: restoredReload.sessionKey }
            : withSessionKey;
          const withSessionBaseConfig = sessionBaseConfig
            ? { ...withReloadHandoffKey, sessionBaseConfig }
            : withReloadHandoffKey;
          const withSessionOverrides = {
            ...withSessionBaseConfig,
            sessionOverrides: restoredReload?.seed ?? profileOverrideHandoff.capture(),
          };
          return withSessionOverrides;
        })();
        activeProfileGeneration = generation;
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

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "reload") {
      profileReloadHandoff.clear();
      return prepareActivation(ctx, false);
    }
    const sessionKey = profileReloadSessionKey(ctx);
    const seed = sessionKey ? profileReloadHandoff.capture(sessionKey) : undefined;
    return prepareActivation(ctx, false, sessionKey && seed ? { sessionKey, seed } : undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!currentContext) return;
    currentContext = ctx;
    bridge.setContext(ctx);
  });

  pi.on("session_tree", (_event, ctx) => prepareActivation(ctx, true));

  pi.on("session_shutdown", (event, ctx) => {
    ++preparationGeneration;
    activeProfileGeneration = -1;
    const sessionKey = profileReloadSessionKey(ctx) ?? currentActivation?.sessionKey;
    if (event.reason === "reload") {
      const authoritative = profileOverrideHandoff.captureAuthoritative();
      if (sessionKey && authoritative) profileReloadHandoff.publish(sessionKey, authoritative);
    } else profileReloadHandoff.clear();
    profileOverrideHandoff.clear();
    rememberDisabledTools(deactivateSubagentTools(pi));
    bridge.clear();
    return slot.shutdown();
  });
}
