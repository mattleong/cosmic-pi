import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CodePreviewSettings,
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
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileOverrideSeed } from "../profiles/session-overrides.ts";
import {
  makeSubagentLayer,
  type SubagentApplication,
  type SubagentRuntimeError,
} from "../layer.ts";
import type { SubagentProjection } from "../run/model.ts";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { SubagentService } from "../run/service.ts";
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
  profileReloadHandoff,
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
  ) => PromiseLike<CodePreviewSettings | void>;
  readonly getAgentDirectory: () => string;
}

const LIVE_APPLICATION_BOUNDARIES: SubagentApplicationBoundaries = {
  loadSettings: loadCodePreviewSettings,
  getAgentDirectory: getAgentDir,
};

/**
 * What started an activation. A session start or reload publishes history replay and rebuilds
 * session overrides from the reload handoff, if any; `/tree` keeps the in-memory overrides.
 */
type ActivationTrigger = "start" | "reload" | "tree";

interface CapturedActivation {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDirectory: string;
  readonly trigger: ActivationTrigger;
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
 * A stale host cannot turn registration cleanup into an unhandled callback error.
 */
const deactivateSubagentTools = (
  pi: ExtensionAPI,
  only?: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  invokeHostCallback(() => {
    const active = pi.getActiveTools();
    const removed = active.filter(
      (name) => SUBAGENT_TOOL_NAME_SET.has(name) && (only?.includes(name) ?? true),
    );
    if (removed.length > 0) pi.setActiveTools(active.filter((name) => !removed.includes(name)));
    return removed;
  }, []);

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
  const profileOverrideHandoff = makeProfileOverrideHandoff();
  let releaseActivity: (() => void) | undefined;
  let currentActivation: CapturedActivation | undefined;
  let startupFailureTools: ReadonlyArray<string> = [];
  let hasRegisteredTools = false;
  let incompatibleReload = false;
  let retainingTools = false;

  /** Deactivates every Subagents tool, remembering what it removed for the next activation. */
  const disableTools = (): void => {
    startupFailureTools = [...new Set([...startupFailureTools, ...deactivateSubagentTools(pi)])];
  };
  /**
   * Ends the current activation's host presence. `keepTools` leaves the tools active, because Pi
   * drops its pending restore list whenever a tool is deactivated.
   */
  const detachActivation = (keepTools: boolean): void => {
    receipts.deactivate();
    releaseActivity?.();
    releaseActivity = undefined;
    ultracode.suspend();
    if (!keepTools) disableTools();
    currentActivation = undefined;
    bridge.clear();
    workflowViews.clear();
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
        if (activation.trigger !== "tree") profileOverrideHandoff.clear();
        const owner = profileOverrideHandoff.open();
        const restoreReload = activation.trigger === "reload" || incompatibleReload;
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
        if (restoredReload) profileOverrideHandoff.publish(owner, restoredReload);
        const sessionBaseConfig = profileOverrideHandoff.captureBaseConfig();
        const layer = makeSubagentLayer({
          sessionKey: activation.sessionKey,
          isProjectTrusted: () => isProjectTrusted(activation.ctx),
          workflowActivity: workflowViews,
          workflowObserver: ultracode.observer(),
          cwd: activation.cwd,
          agentDirectory: activation.agentDirectory,
          projectTrusted: activation.projectTrusted,
          ...(sessionBaseConfig && { sessionBaseConfig }),
          publishSessionBaseConfig: (config) =>
            profileOverrideHandoff.publishBaseConfig(owner, config),
          initialSessionOverrides: restoredReload ?? profileOverrideHandoff.capture(),
          publishSessionOverrides: (seed) => profileOverrideHandoff.publish(owner, seed),
          publish: bridge.publish,
          notify,
          questionnaireHandler: (request, questionnaireOwner) =>
            askParentQuestionnaire(
              pi.events,
              activation.ctx.sessionManager.getSessionId(),
              request,
              questionnaireOwner,
            ),
          proxyHandler: (service, callerRunId, request) =>
            Effect.gen(function* () {
              const input = decodeSubagentProxyRequest(request);
              if (input instanceof InvalidSubagentRequestError) return yield* input;
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
            }),
        });
        return makePiManagedRuntime(pi, layer, {
          agentDirectory: () => activation.agentDirectory,
          packageName: "pi-subagents",
        });
      },
      startup: (activation) =>
        Effect.gen(function* () {
          yield* bestEffortHostBootstrap("pi-subagents.preview-settings", (signal) =>
            boundaries.loadSettings(activation.cwd, activation.projectTrusted, signal),
          );
          const projection = yield* SubagentService.use((service) => service.projection);
          const scheduler = yield* CodePreviewSchedulerService;
          // Feature switches follow the session's frozen base config and its own values, so saved
          // changes apply after /reload while /tree keeps the values this session started with.
          const profiles = yield* SubagentProfileService.use((service) => service.capture);
          // The inactive workflow tool's description lists saved workflows as the session found
          // them at start; the model sees them only while workflows are opted in.
          const store = yield* WorkflowStore;
          const savedWorkflows = (yield* store.list).workflows;
          const savedWorkflowLocations = yield* store.locations;
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
              run: slot.run,
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
              run: slot.run,
            },
            replay.shell,
          );
          // A first registration keeps what Pi activated. Later ones deactivate only tools Pi
          // activated that the session had not kept active.
          if (hasRegisteredTools)
            deactivateSubagentTools(
              pi,
              activeSubagentTools(pi).filter(
                (name) => !keptActive.has(name) && !startupFailureTools.includes(name),
              ),
            );
          hasRegisteredTools = true;
        } catch {
          disableTools();
          if (!slot.isCurrent(token)) return;
          notifyActivationFailure(activation.ctx, "Subagents couldn't register their tools");
          if (slot.isCurrent(token)) void slot.shutdown();
          return;
        }
        if (!slot.isCurrent(token)) {
          disableTools();
          return;
        }
        if (activation.trigger !== "tree") replay.publish();
        bridge.publish(prepared.projection);
        currentActivation = activation;
        if (activation.trigger === "reload" && activation.sessionKey)
          profileReloadHandoff.clear(activation.sessionKey);
        bridge.setContext(activation.ctx);
        ultracode.activate(activation.ctx, prepared.ultracode);
        // The workflow tool's activation is the ultracode controller's alone.
        reactivateSubagentTools(
          pi,
          startupFailureTools.filter((name) => name !== WORKFLOW_TOOL_NAME),
        );
        startupFailureTools = [];
        const isCurrent = () => slot.isCurrent(token) && currentActivation === activation;
        if (activation.sessionKey && slot.isCurrent(token))
          releaseActivity = registerSubagentActivity({
            events: pi.events,
            sessionId: activation.sessionKey,
            bridge,
            workflows: workflowViews,
            actWorkflow: (action, id, signal) =>
              slot.run(
                WorkflowService.use((workflows) =>
                  action === "stop" ? workflows.stop(id).pipe(Effect.asVoid) : workflows.skip(id),
                ),
                signal,
              ),
            isCurrent,
            input: (selected, action, signal) =>
              slot.run(promptSubagentActivityInput(activation.ctx, selected, action), signal),
            act: (id, action, signal, input) =>
              slot.run(
                SubagentService.use((service) => {
                  if (action === "message")
                    return service.send(id, input!).pipe(
                      Effect.catchIf(isPendingDeliveryError, () =>
                        Effect.sync(() => {
                          if (isCurrent())
                            notifyAtHostBoundary(
                              activation.ctx,
                              "Guidance delivery is still pending",
                              "warning",
                            );
                        }),
                      ),
                      Effect.asVoid,
                    );
                  if (action === "reply" || action === "rename")
                    return service[action](id, input!).pipe(Effect.asVoid);
                  if (action === "resume") return service.resume(id, input).pipe(Effect.asVoid);
                  return service[action](id).pipe(Effect.asVoid);
                }),
                signal,
              ),
          });
        if (!slot.isCurrent(token)) detachActivation(false);
      },
      onDeactivated: () => detachActivation(retainingTools),
      onStartFailure: (activation) => {
        disableTools();
        notifyActivationFailure(
          activation.ctx,
          incompatibleReload
            ? "Subagents cannot restore this session's profile settings; start a fresh Pi session"
            : "Subagents couldn't start; check pi-subagents.json, then run /reload",
        );
      },
    });

  registerApplicationCommands(pi, {
    bridge,
    ultracode,
    run: slot.run,
    current: () => currentActivation,
    isActive: () => slot.isActive(),
  });

  const prepareActivation = (ctx: ExtensionContext, trigger: ActivationTrigger): Promise<void> => {
    const tree = trigger === "tree";
    // No registered Subagents tool may target the inactive slot while capture or replacement is
    // pending. Preserve only names that were active before deactivation. A replacement that
    // keeps the tools deactivates them only if it ends without an activation.
    detachActivation(tree);
    // Runs the replaced activation leaves open are announced again, which reopens the window.
    ultracode.reset();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return slot.shutdown();
    const projectTrusted = isProjectTrusted(ctx);
    const agentDirectory = invokeHostCallback<string | undefined>(
      () => boundaries.getAgentDirectory(),
      undefined,
    );
    if (agentDirectory === undefined) {
      const shutdown = slot.shutdown();
      notifyActivationFailure(ctx, "Subagents couldn't read this session's environment");
      return shutdown;
    }
    const activation: CapturedActivation = {
      ctx,
      cwd: captured.cwd,
      projectTrusted,
      agentDirectory,
      trigger,
      sessionKey: profileReloadSessionKey(ctx),
    };
    const start = () => slot.start(activation, captured.signal);
    return (tree ? retainingToolsDuring(start) : start()).then(() => undefined);
  };

  pi.on("session_start", (event, ctx) => {
    // Pi emits one session_start per factory load; history adopts only if this startup publishes.
    try {
      const trigger = event.reason === "reload" ? "reload" : "start";
      if (trigger === "start") profileReloadHandoff.clear();
      return prepareActivation(ctx, trigger).finally(replay.finishStartup);
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
  pi.on("session_tree", (_event, ctx) => prepareActivation(ctx, "tree"));

  pi.on("session_shutdown", (event, ctx) => {
    const reload = event.reason === "reload";
    replay.retire();
    const sessionKey = profileReloadSessionKey(ctx) ?? currentActivation?.sessionKey;
    detachActivation(reload);
    ultracode.reset();
    if (reload) {
      const authoritative = profileOverrideHandoff.captureAuthoritative();
      if (sessionKey && authoritative) profileReloadHandoff.publish(sessionKey, authoritative);
    } else profileReloadHandoff.clear();
    // Clearing the handoff also retires the outgoing runtime's publication.
    profileOverrideHandoff.clear();
    return reload ? retainingToolsDuring(() => slot.shutdown()) : slot.shutdown();
  });
}
