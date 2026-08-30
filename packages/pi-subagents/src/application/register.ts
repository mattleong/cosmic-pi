import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { loadCodePreviewSettings } from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  type PiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { makeHostNotifier } from "../boundary/host-notifier.ts";
import { makeSubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { BackendProxyRequest } from "../backend/model.ts";
import { NativeModelCatalog } from "../boundary/native-model-catalog.ts";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { SubagentConfigStore, type SubagentConfigStoreContract } from "../config/store.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileOverrideSeed } from "../profiles/session-overrides.ts";
import {
  makeSubagentLayer,
  type SubagentApplication,
  type SubagentRuntimeError,
} from "../layer.ts";
import type { SubagentProjection } from "../run/model.ts";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../run/service.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { registerSubagentManagerCommand } from "../settings/controller.ts";
import { executeSubagentActionEffect } from "../tools/execute.ts";
import { decodeSubagentProxyRequest } from "../tools/proxy-protocol.ts";
import { registerSubagentTools, type SubagentToolRuntime } from "../tools/subagent.ts";
import { makeProfileOverrideHandoff } from "./profile-override-handoff.ts";
import { makeProfileReloadHandoff, profileReloadSessionKey } from "./profile-reload-handoff.ts";

const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);

export interface SubagentApplicationBoundaries {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
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
  readonly preserveSessionOverrides: boolean;
  readonly restoreReloadHandoff: boolean;
  readonly sessionKey?: string | undefined;
}

interface PreparedActivation {
  readonly projection: SubagentProjection;
  readonly toolRuntime: SubagentToolRuntime;
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
  let currentActivation: CapturedActivation | undefined;
  let startupFailureTools: ReadonlyArray<string> = [];
  let profileGeneration = 0;
  let activeProfileGeneration = -1;
  const profileOverrideHandoff = makeProfileOverrideHandoff();
  const profileReloadHandoff = makeProfileReloadHandoff();
  let hasRegisteredTools = false;

  const rememberDisabledTools = (names: ReadonlyArray<string>): void => {
    startupFailureTools = [...new Set([...startupFailureTools, ...names])];
  };

  const slot: PiSessionRuntimeSlot<CapturedActivation, SubagentApplication, SubagentRuntimeError> =
    makePiSessionRuntimeSlot<
      CapturedActivation,
      SubagentApplication,
      never,
      SubagentRuntimeError,
      PreparedActivation
    >({
      makeRuntime: (activation) => {
        if (!activation.preserveSessionOverrides) profileOverrideHandoff.clear();
        const generation = ++profileGeneration;
        activeProfileGeneration = generation;
        const restoredReload =
          activation.restoreReloadHandoff && activation.sessionKey
            ? profileReloadHandoff.capture(activation.sessionKey)
            : undefined;
        if (restoredReload) profileOverrideHandoff.publish(generation, generation, restoredReload);
        const sessionBaseConfig = profileOverrideHandoff.captureBaseConfig();
        const sessionOverrides = restoredReload ?? profileOverrideHandoff.capture();
        return makePiManagedRuntime(
          pi,
          makeSubagentLayer(
            (() => {
              const baseResult = {
                cwd: activation.cwd,
                agentDirectory: activation.agentDirectory,
                projectTrusted: activation.projectTrusted,
              };
              const withSessionBaseConfig = sessionBaseConfig
                ? { ...baseResult, sessionBaseConfig }
                : baseResult;
              const withPublishSessionBaseConfigAndAdditionalFields = {
                ...withSessionBaseConfig,
                publishSessionBaseConfig: (config: ResolvedSubagentConfig) =>
                  profileOverrideHandoff.publishBaseConfig(
                    generation,
                    activeProfileGeneration,
                    config,
                  ),
                initialSessionOverrides: sessionOverrides,
                publishSessionOverrides: (seed: SessionProfileOverrideSeed) =>
                  profileOverrideHandoff.publish(generation, activeProfileGeneration, seed),
                publish: bridge.publish,
                notify,
                proxyHandler: (
                  service: SubagentServiceContract,
                  callerRunId: string,
                  request: BackendProxyRequest,
                ) => {
                  const input = decodeSubagentProxyRequest(request);
                  if (input instanceof InvalidSubagentRequestError) return Effect.fail(input);
                  return executeSubagentActionEffect(
                    pi,
                    {
                      cwd: activation.cwd,
                      projectTrusted: activation.projectTrusted,
                    },
                    input,
                    undefined,
                    undefined,
                    activation.ctx,
                    callerRunId,
                  ).pipe(Effect.provideService(SubagentService, service));
                },
              };
              return withPublishSessionBaseConfigAndAdditionalFields;
            })(),
          ),
          { agentDirectory: () => activation.agentDirectory, packageName: "pi-subagents" },
        );
      },
      startup: (activation) =>
        Effect.gen(function* () {
          yield* bestEffortHostBootstrap("pi-subagents.preview-settings", (signal) =>
            Promise.resolve(
              boundaries.loadSettings(activation.cwd, activation.projectTrusted, signal),
            ).then(() => undefined),
          );
          const projection = yield* SubagentService.use((service) => service.projection);
          return {
            projection,
            toolRuntime: {
              environment: {
                cwd: activation.cwd,
                projectTrusted: activation.projectTrusted,
              },
              toolPresentation: bridge.bindToolPresentation(),
              run: (effect, signal) => run(effect, signal),
            },
          };
        }),
      onActivated: (activation, token, prepared) => {
        if (!slot.isCurrent(token)) return;
        try {
          registerSubagentTools(pi, prepared.toolRuntime);
          const activatedByRegistration = deactivateSubagentTools(pi);
          if (!hasRegisteredTools) rememberDisabledTools(activatedByRegistration);
          hasRegisteredTools = true;
        } catch {
          rememberDisabledTools(deactivateSubagentTools(pi));
          if (!slot.isCurrent(token)) return;
          notifyActivationFailure(
            activation.ctx,
            "Subagents failed to activate because tool registration failed.",
          );
          if (slot.isCurrent(token)) void slot.shutdown();
          return;
        }
        if (!slot.isCurrent(token)) {
          rememberDisabledTools(deactivateSubagentTools(pi));
          return;
        }
        bridge.publish(prepared.projection);
        currentActivation = activation;
        if (activation.restoreReloadHandoff && activation.sessionKey)
          profileReloadHandoff.clear(activation.sessionKey);
        bridge.setContext(activation.ctx);
        reactivateSubagentTools(pi, startupFailureTools);
        startupFailureTools = [];
        if (!slot.isCurrent(token)) {
          rememberDisabledTools(deactivateSubagentTools(pi));
          currentActivation = undefined;
          bridge.clear();
        }
      },
      onDeactivated: () => {
        rememberDisabledTools(deactivateSubagentTools(pi));
        currentActivation = undefined;
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

  const run = <A, E>(
    effect: Effect.Effect<A, E, SubagentApplication>,
    signal?: AbortSignal,
  ): Promise<A> => slot.run(effect, signal);

  const withCurrentActivation = <A>(
    operation: (activation: CapturedActivation) => Promise<A>,
  ): Promise<A> => {
    const activation = currentActivation;
    return activation
      ? operation(activation)
      : Promise.reject(new Error("Subagents are not active; run /reload and try again."));
  };

  const withConfigStore =
    <Patch, E>(
      select: (
        store: SubagentConfigStoreContract,
      ) => (cwd: string, agentDirectory: string, patch: Patch) => Effect.Effect<void, E>,
    ) =>
    (patch: Patch): Promise<void> =>
      withCurrentActivation((activation) =>
        run(
          SubagentConfigStore.use((store) =>
            select(store)(activation.cwd, activation.agentDirectory, patch),
          ),
        ),
      );

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
    inspectProfiles: (projectTrusted) =>
      withCurrentActivation((activation) =>
        run(
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
        ),
      ),
    patchProfile: withConfigStore((store) => store.patchProfile),
    patchDefaultProfileSet: withConfigStore((store) => store.patchDefaultProfileSet),
    createProfileSetFromSnapshot: (request) =>
      withCurrentActivation((activation) => {
        const { expectedRevision, ...patch } = request;
        return run(
          Effect.gen(function* () {
            const store = yield* SubagentConfigStore;
            const profiles = yield* SubagentProfileService;
            yield* profiles.withSnapshotAtRevision(expectedRevision, (snapshot) =>
              store.createProfileSetFromSnapshot(activation.cwd, activation.agentDirectory, {
                ...patch,
                profiles: snapshot.effectiveConfig.profiles,
              }),
            );
          }),
        );
      }),
    copyProfileSet: withConfigStore((store) => store.copyProfileSet),
    renameProfileSet: withConfigStore((store) => store.renameProfileSet),
    deleteProfileSet: withConfigStore((store) => store.deleteProfileSet),
    patchNesting: withConfigStore((store) => store.patchNesting),
    patchSessionProfile: (patch) =>
      run(SubagentProfileService.use((profiles) => profiles.patchSessionProfile(patch))).then(
        () => undefined,
      ),
    replaceSessionProfiles: (patch) =>
      run(SubagentProfileService.use((profiles) => profiles.replaceSessionProfiles(patch))).then(
        () => undefined,
      ),
    patchSessionNesting: (patch) =>
      run(SubagentProfileService.use((profiles) => profiles.patchSessionNesting(patch))).then(
        () => undefined,
      ),
    listNativeModels: (runtime, signal) =>
      withCurrentActivation((activation) =>
        run(
          Effect.flatMap(NativeModelCatalog, (catalog) => catalog.list(runtime, activation.cwd)),
          signal,
        ),
      ),
  });

  const prepareActivation = (
    ctx: ExtensionContext,
    preserveSessionOverrides: boolean,
    restoreReloadHandoff: boolean,
  ): Promise<void> => {
    bridge.clear();
    // No registered Subagents tool may target the inactive slot while capture or replacement is
    // pending. Preserve only names that were active before deactivation.
    rememberDisabledTools(deactivateSubagentTools(pi));
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return slot.shutdown();
    const projectTrusted = isProjectTrusted(ctx);
    let agentDirectory: string;
    try {
      agentDirectory = (boundaries.getAgentDirectory ?? getAgentDir)();
    } catch {
      const shutdown = slot.shutdown();
      notifyActivationFailure(ctx, "Subagents failed to capture the session environment.");
      return shutdown;
    }
    const sessionKey = profileReloadSessionKey(ctx);
    const activationBase = {
      ctx,
      cwd: captured.cwd,
      projectTrusted,
      agentDirectory,
      preserveSessionOverrides,
      restoreReloadHandoff,
    };
    const activation: CapturedActivation = sessionKey
      ? { ...activationBase, sessionKey }
      : activationBase;
    return slot.start(activation, captured.signal).then(() => undefined);
  };

  pi.on("session_start", (event, ctx) => {
    const restoreReloadHandoff = event.reason === "reload";
    if (!restoreReloadHandoff) profileReloadHandoff.clear();
    return prepareActivation(ctx, false, restoreReloadHandoff);
  });

  pi.on("turn_end", () => {
    if (!currentActivation) return;
    bridge.setContext(currentActivation.ctx);
  });

  pi.on("session_tree", (_event, ctx) => prepareActivation(ctx, true, false));

  pi.on("session_shutdown", (event, ctx) => {
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
