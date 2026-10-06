import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  loadCodePreviewSettings,
  registerCodePreviewReplay,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  type PiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import {
  makeWorkflowActivitySource,
  promptSubagentActivityInput,
  registerSubagentActivity,
} from "../boundary/host-activity.ts";
import { askParentQuestionnaire } from "../boundary/host-ask-user.ts";
import { makeHostNotifier } from "../boundary/host-notifier.ts";
import { registerSubagentErrorReceipts } from "../boundary/host-tool-result.ts";
import { makeSubagentProjectionBridge } from "../boundary/host-ui.ts";
import type { BackendProxyRequest } from "../backend/model.ts";
import type { ResolvedSubagentConfig } from "../config/options.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileOverrideSeed } from "../profiles/session-overrides.ts";
import {
  makeSubagentLayer,
  type SubagentApplication,
  type SubagentLayerOptions,
  type SubagentRuntimeError,
} from "../layer.ts";
import type { SubagentProjection } from "../run/model.ts";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { SubagentService, type SubagentServiceContract } from "../run/service.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { executeSubagentActionEffect, type SubagentToolRuntime } from "../tools/execute.ts";
import { isPendingDeliveryError } from "../tools/outcome.ts";
import { decodeSubagentProxyRequest } from "../tools/proxy-protocol.ts";
import { registerSubagentTools } from "../tools/subagent.ts";
import { registerWorkflowTool } from "../tools/workflow.ts";
import {
  WorkflowStore,
  type SavedWorkflowSummary,
  type WorkflowLocations,
} from "../workflow/store.ts";
import { WORKFLOW_TOOL_NAME } from "../tools/workflow-schema.ts";
import { WorkflowService } from "../workflow/service.ts";
import { registerApplicationCommands } from "./commands.ts";
import { registerSubagentMessageRenderers } from "./messages.ts";
import { registerUltracodeController } from "./ultracode.ts";
import { makeProfileOverrideHandoff } from "./profile-override-handoff.ts";
import {
  IncompatibleProfileReloadHandoffError,
  makeProfileReloadHandoff,
  profileReloadSessionKey,
} from "./profile-reload-handoff.ts";

// The workflow tool is root-only and outside the child proxy catalog, but shares its lifecycle.
const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set([
  ...SUBAGENT_TOOL_NAMES,
  WORKFLOW_TOOL_NAME,
]);

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
  /** Only session_start may publish history replay; a /tree activation never wins it. */
  readonly publishesReplay: boolean;
  readonly sessionKey?: string | undefined;
}

interface PreparedActivation {
  readonly scheduler: CodePreviewSchedulerServiceContract;
  readonly projection: SubagentProjection;
  readonly savedWorkflows: ReadonlyArray<SavedWorkflowSummary>;
  readonly savedWorkflowLocations: WorkflowLocations;
  readonly toolRuntime: SubagentToolRuntime;
  /** The session's effective ultracode setting when its tools register. */
  readonly ultracode: boolean;
}

/**
 * Deactivates active Subagents tools, optionally only those in `only`, and returns the names it
 * removed. Pi drops its pending restore list (tools still registering after /reload, such as
 * MCP tools) whenever a call removes a tool, so nothing is set when nothing would be removed.
 */
function deactivateSubagentTools(
  pi: ExtensionAPI,
  only?: ReadonlySet<string>,
): ReadonlyArray<string> {
  try {
    const active = pi.getActiveTools();
    const removed = active.filter(
      (name) => SUBAGENT_TOOL_NAME_SET.has(name) && (only === undefined || only.has(name)),
    );
    if (removed.length === 0) return [];
    const removing = new Set(removed);
    pi.setActiveTools(active.filter((name) => !removing.has(name)));
    return removed;
  } catch {
    // A stale host cannot turn registration cleanup into an unhandled callback error.
    return [];
  }
}

const activeSubagentTools = (pi: ExtensionAPI): ReadonlyArray<string> =>
  invokeHostCallback(
    () => pi.getActiveTools().filter((name) => SUBAGENT_TOOL_NAME_SET.has(name)),
    [],
  );

function reactivateSubagentTools(pi: ExtensionAPI, names: ReadonlyArray<string>): void {
  if (names.length === 0) return;
  invokeHostCallback(
    () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]),
    undefined,
  );
}

function notifyActivationFailure(ctx: ExtensionContext, message: string): void {
  if (invokeHostCallback(() => ctx.hasUI, false)) notifyAtHostBoundary(ctx, message, "warning");
}

export function registerSubagentApplication(
  pi: ExtensionAPI,
  boundaries: SubagentApplicationBoundaries = LIVE_APPLICATION_BOUNDARIES,
): void {
  registerSubagentMessageRenderers(pi);
  // Pi draws history before session_start registers the tools; `/subagents` anchors ownership.
  const replay = registerCodePreviewReplay(pi, {
    command: "subagents",
    tools: [...SUBAGENT_TOOL_NAME_SET],
  });
  const receipts = registerSubagentErrorReceipts(pi);
  const bridge = makeSubagentProjectionBridge(pi.events);
  const workflowViews = makeWorkflowActivitySource();
  const notify = makeHostNotifier(pi);
  const ultracode = registerUltracodeController(pi);
  let releaseActivity: (() => void) | undefined;
  const revokeActivity = () => {
    releaseActivity?.();
    releaseActivity = undefined;
  };
  let currentActivation: CapturedActivation | undefined;
  let startupFailureTools: ReadonlyArray<string> = [];
  let profileGeneration = 0;
  let activeProfileGeneration = -1;
  const profileOverrideHandoff = makeProfileOverrideHandoff();
  const profileReloadHandoff = makeProfileReloadHandoff();
  let hasRegisteredTools = false;
  let incompatibleReload = false;
  let retainingTools = false;

  const rememberDisabledTools = (names: ReadonlyArray<string>): void => {
    startupFailureTools = [...new Set([...startupFailureTools, ...names])];
  };
  /**
   * Runs a slot transition whose synchronous deactivation of the outgoing runtime keeps the
   * tools active, because Pi drops its pending restore list whenever a tool is deactivated.
   * Tree navigation awaits the replacement, which still deactivates the tools if it ends
   * without an activation; reload invalidates the outgoing instance's tools after shutdown.
   */
  const retainingToolsDuring = <A>(transition: () => A): A => {
    retainingTools = true;
    try {
      return transition();
    } finally {
      retainingTools = false;
    }
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
        const restoreReload = activation.restoreReloadHandoff || incompatibleReload;
        incompatibleReload = false;
        let restoredReload: SessionProfileOverrideSeed | undefined;
        try {
          restoredReload =
            restoreReload && activation.sessionKey
              ? profileReloadHandoff.capture(activation.sessionKey)
              : undefined;
        } catch (error) {
          incompatibleReload = error instanceof IncompatibleProfileReloadHandoffError;
          throw error;
        }
        if (restoredReload) profileOverrideHandoff.publish(generation, generation, restoredReload);
        const sessionBaseConfig = profileOverrideHandoff.captureBaseConfig();
        const sessionOverrides = restoredReload ?? profileOverrideHandoff.capture();
        const layerOptions: SubagentLayerOptions = {
          ...(activation.sessionKey && {
            workspaceOwnerId: activation.sessionKey,
            sessionKey: activation.sessionKey,
          }),
          isProjectTrusted: () => isProjectTrusted(activation.ctx),
          workflowActivity: workflowViews,
          workflowObserver: ultracode.observer(),
          cwd: activation.cwd,
          agentDirectory: activation.agentDirectory,
          projectTrusted: activation.projectTrusted,
          ...(sessionBaseConfig && { sessionBaseConfig }),
          publishSessionBaseConfig: (config: ResolvedSubagentConfig) =>
            profileOverrideHandoff.publishBaseConfig(generation, activeProfileGeneration, config),
          initialSessionOverrides: sessionOverrides,
          publishSessionOverrides: (seed: SessionProfileOverrideSeed) =>
            profileOverrideHandoff.publish(generation, activeProfileGeneration, seed),
          publish: bridge.publish,
          notify,
          questionnaireHandler: (request, owner) =>
            askParentQuestionnaire(
              pi.events,
              activation.ctx.sessionManager.getSessionId(),
              request,
              owner,
            ),
          proxyHandler: (
            service: SubagentServiceContract,
            callerRunId: string,
            request: BackendProxyRequest,
          ) => {
            const input = decodeSubagentProxyRequest(request);
            if (input instanceof InvalidSubagentRequestError) return Effect.fail(input);
            return Effect.gen(function* () {
              const caller = (yield* service.visibleList(callerRunId)).find(
                (run) => run.id === callerRunId,
              );
              if (!caller)
                return yield* new InvalidSubagentRequestError({
                  code: "parent_run_not_found",
                  message: "The authenticated caller is no longer registered.",
                });
              return yield* executeSubagentActionEffect(
                pi,
                { cwd: caller.cwd, projectTrusted: activation.projectTrusted },
                input,
                undefined,
                activation.ctx,
                callerRunId,
              ).pipe(Effect.provideService(SubagentService, service));
            });
          },
        };
        return makePiManagedRuntime(pi, makeSubagentLayer(layerOptions), {
          agentDirectory: () => activation.agentDirectory,
          packageName: "pi-subagents",
        });
      },
      startup: (activation) =>
        Effect.gen(function* () {
          yield* bestEffortHostBootstrap("pi-subagents.preview-settings", (signal) =>
            Promise.resolve(
              boundaries.loadSettings(activation.cwd, activation.projectTrusted, signal),
            ).then(() => undefined),
          );
          const projection = yield* SubagentService.use((service) => service.projection);
          const scheduler = yield* CodePreviewSchedulerService;
          // Feature switches follow the session's frozen base config and its own values, so saved
          // changes apply after /reload while /tree keeps the values this session started with.
          const profiles = yield* SubagentProfileService.use((service) => service.capture);
          // The inactive workflow tool's description lists saved workflows as the session found
          // them at start; the model sees them only while workflows are opted in.
          const savedWorkflows = (yield* WorkflowStore.use((store) => store.list)).workflows;
          const savedWorkflowLocations = yield* WorkflowStore.use((store) => store.locations);
          return {
            scheduler,
            projection,
            savedWorkflows,
            savedWorkflowLocations,
            ultracode: profiles.effectiveConfig.ultracode,
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
          const scheduleAnimation = (interval: number, tick: () => void) =>
            slot.isCurrent(token) ? prepared.scheduler.schedule(interval, tick) : undefined;
          // Tools a tree replacement kept active are not activations by this registration.
          const keptActive = new Set(activeSubagentTools(pi));
          registerSubagentTools(
            pi,
            { ...prepared.toolRuntime, scheduleAnimation },
            { receipts, owner: receipts.activate() },
            replay.shell,
          );
          // Registered inactive; the ultracode controller activates it while workflows are on.
          registerWorkflowTool(
            pi,
            {
              environment: prepared.toolRuntime.environment,
              savedWorkflows: prepared.savedWorkflows,
              savedWorkflowLocations: prepared.savedWorkflowLocations,
              scheduleAnimation,
              run: (effect, signal) => run(effect, signal),
            },
            replay.shell,
          );
          // A first registration keeps what Pi activated. Later ones deactivate only tools Pi
          // activated that the session had not kept active.
          const activatedByRegistration = activeSubagentTools(pi).filter(
            (name) => !keptActive.has(name),
          );
          if (!hasRegisteredTools) rememberDisabledTools(activatedByRegistration);
          else
            deactivateSubagentTools(
              pi,
              new Set(
                activatedByRegistration.filter((name) => !startupFailureTools.includes(name)),
              ),
            );
          hasRegisteredTools = true;
        } catch {
          rememberDisabledTools(deactivateSubagentTools(pi));
          if (!slot.isCurrent(token)) return;
          notifyActivationFailure(activation.ctx, "Subagents couldn't register their tools");
          if (slot.isCurrent(token)) void slot.shutdown();
          return;
        }
        if (!slot.isCurrent(token)) {
          rememberDisabledTools(deactivateSubagentTools(pi));
          return;
        }
        if (activation.publishesReplay) replay.publish();
        bridge.publish(prepared.projection);
        currentActivation = activation;
        if (activation.restoreReloadHandoff && activation.sessionKey)
          profileReloadHandoff.clear(activation.sessionKey);
        bridge.setContext(activation.ctx);
        ultracode.activate(activation.ctx, prepared.ultracode);
        // The workflow tool's activation is the ultracode controller's alone.
        reactivateSubagentTools(
          pi,
          startupFailureTools.filter((name) => name !== WORKFLOW_TOOL_NAME),
        );
        startupFailureTools = [];
        if (activation.sessionKey && slot.isCurrent(token))
          releaseActivity = registerSubagentActivity({
            events: pi.events,
            sessionId: activation.sessionKey,
            bridge,
            workflows: workflowViews,
            actWorkflow: (action, id, signal) =>
              run(
                WorkflowService.use((workflows) =>
                  action === "stop" ? workflows.stop(id).pipe(Effect.asVoid) : workflows.skip(id),
                ),
                signal,
              ),
            isCurrent: () => slot.isCurrent(token) && currentActivation === activation,
            input: (selected, action, signal) =>
              run(promptSubagentActivityInput(activation.ctx, selected, action), signal),
            act: (id, action, signal, input) =>
              run(
                SubagentService.use((service) => {
                  if (action === "message")
                    return service.send(id, input!).pipe(
                      Effect.catchIf(isPendingDeliveryError, () =>
                        Effect.sync(() => {
                          if (slot.isCurrent(token) && currentActivation === activation)
                            notifyAtHostBoundary(
                              activation.ctx,
                              "Guidance delivery is still pending",
                              "warning",
                            );
                        }),
                      ),
                      Effect.asVoid,
                    );
                  if (action === "reply") return service.reply(id, input!).pipe(Effect.asVoid);
                  if (action === "rename") return service.rename(id, input!).pipe(Effect.asVoid);
                  if (action === "resume") return service.resume(id, input).pipe(Effect.asVoid);
                  return service[action](id).pipe(Effect.asVoid);
                }),
                signal,
              ),
          });
        if (!slot.isCurrent(token)) {
          revokeActivity();
          ultracode.suspend();
          rememberDisabledTools(deactivateSubagentTools(pi));
          currentActivation = undefined;
          bridge.clear();
          workflowViews.clear();
        }
      },
      onDeactivated: () => {
        receipts.deactivate();
        revokeActivity();
        ultracode.suspend();
        if (!retainingTools) rememberDisabledTools(deactivateSubagentTools(pi));
        currentActivation = undefined;
        bridge.clear();
        workflowViews.clear();
      },
      onStartFailure: (activation) => {
        rememberDisabledTools(deactivateSubagentTools(pi));
        notifyActivationFailure(
          activation.ctx,
          incompatibleReload
            ? "Subagents cannot restore this session's profile settings; start a fresh Pi session"
            : "Subagents couldn't start; check pi-subagents.json, then run /reload",
        );
      },
    });

  const run = <A, E>(
    effect: Effect.Effect<A, E, SubagentApplication>,
    signal?: AbortSignal,
  ): Promise<A> => slot.run(effect, signal);

  registerApplicationCommands(pi, {
    bridge,
    ultracode,
    run,
    current: () => currentActivation,
    isActive: () => slot.isActive(),
  });

  const prepareActivation = (
    ctx: ExtensionContext,
    preserveSessionOverrides: boolean,
    restoreReloadHandoff: boolean,
    keepTools = false,
  ): Promise<void> => {
    receipts.deactivate();
    revokeActivity();
    ultracode.suspend();
    // Runs the replaced activation leaves open are announced again, which reopens the window.
    ultracode.reset();
    currentActivation = undefined;
    bridge.clear();
    workflowViews.clear();
    // No registered Subagents tool may target the inactive slot while capture or replacement is
    // pending. Preserve only names that were active before deactivation. A replacement that
    // keeps the tools deactivates them only if it ends without an activation.
    if (!keepTools) rememberDisabledTools(deactivateSubagentTools(pi));
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return slot.shutdown();
    const projectTrusted = isProjectTrusted(ctx);
    let agentDirectory: string;
    try {
      agentDirectory = (boundaries.getAgentDirectory ?? getAgentDir)();
    } catch {
      const shutdown = slot.shutdown();
      notifyActivationFailure(ctx, "Subagents couldn't read this session's environment");
      return shutdown;
    }
    const activation: CapturedActivation = {
      ctx,
      cwd: captured.cwd,
      projectTrusted,
      agentDirectory,
      preserveSessionOverrides,
      restoreReloadHandoff,
      // Tree navigation alone preserves the session's overrides.
      publishesReplay: !preserveSessionOverrides,
      sessionKey: profileReloadSessionKey(ctx),
    };
    const start = () => slot.start(activation, captured.signal);
    return (keepTools ? retainingToolsDuring(start) : start()).then(() => undefined);
  };

  pi.on("session_start", (event, ctx) => {
    // Pi emits one session_start per factory load; history adopts only if this startup publishes.
    try {
      const restoreReloadHandoff = event.reason === "reload";
      if (!restoreReloadHandoff) profileReloadHandoff.clear();
      return prepareActivation(ctx, false, restoreReloadHandoff).finally(replay.finishStartup);
    } catch (error) {
      replay.finishStartup();
      throw error;
    }
  });

  pi.on("turn_end", () => {
    if (!currentActivation) return;
    bridge.setContext(currentActivation.ctx);
  });

  // Pi restored the target branch's tool loadout just before this event.
  pi.on("session_tree", (_event, ctx) => prepareActivation(ctx, true, false, true));

  pi.on("session_shutdown", (event, ctx) => {
    replay.retire();
    receipts.deactivate();
    revokeActivity();
    ultracode.suspend();
    ultracode.reset();
    activeProfileGeneration = -1;
    const sessionKey = profileReloadSessionKey(ctx) ?? currentActivation?.sessionKey;
    currentActivation = undefined;
    if (event.reason === "reload") {
      const authoritative = profileOverrideHandoff.captureAuthoritative();
      if (sessionKey && authoritative) profileReloadHandoff.publish(sessionKey, authoritative);
    } else profileReloadHandoff.clear();
    profileOverrideHandoff.clear();
    bridge.clear();
    workflowViews.clear();
    if (event.reason === "reload") return retainingToolsDuring(() => slot.shutdown());
    rememberDisabledTools(deactivateSubagentTools(pi));
    return slot.shutdown();
  });
}
