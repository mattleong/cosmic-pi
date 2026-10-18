import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
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
  promptSubagentActivityInput,
  registerSubagentActivity,
  runSubagentActivityAction,
} from "../boundary/host-activity.ts";
import { askParentQuestionnaire } from "../boundary/host-ask-user.ts";
import { registerActiveRunsPrompt } from "../boundary/host-active-runs-prompt.ts";
import { registerDelegationPrompt } from "../boundary/host-delegation-prompt.ts";
import { hostNotifier } from "../boundary/host-notifier.ts";
import {
  notifyStoppedRuns,
  reportStoppedRuns,
  type RuntimeRetirement,
  runsStoppedByReplacement,
} from "../boundary/host-stopped-runs.ts";
import { registerParentWake } from "../boundary/host-parent-wake.ts";
import { sessionReportArchive, type ReportArchive } from "../boundary/report-archive.ts";
import { subagentSessionFooter } from "../boundary/host-session-footer.ts";
import { restoreSessionUsage, sessionUsageRecorder } from "../boundary/host-session-usage.ts";
import { registerSubagentErrorReceipts } from "../boundary/host-tool-result.ts";
import { registerUserInputSignal } from "../boundary/host-user-input.ts";
import { subagentProjectionBridge } from "../boundary/host-ui.ts";
import type { SessionProfileOverrideSeed } from "../profiles/session-overrides.ts";
import {
  subagentApplicationLayer,
  type SubagentApplication,
  type SubagentRuntimeError,
} from "../layer.ts";
import type { SubagentProjection } from "../run/model.ts";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import { SubagentService } from "../run/service.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { executeSubagentActionEffect, type SubagentToolRuntime } from "../tools/execute.ts";
import { decodeSubagentProxyParent, decodeSubagentProxyRequest } from "../tools/proxy-protocol.ts";
import { registerSubagentTools } from "../tools/subagent.ts";
import { registerApplicationCommands } from "./commands.ts";
import { orphanSweepNotice, registerSubagentMessageRenderers } from "./messages.ts";
import { createProfileOverrideHandoff } from "./profile-override-handoff.ts";
import {
  IncompatibleProfileReloadHandoffError,
  profileReloadHandoff,
  profileReloadSessionKey,
} from "./profile-reload-handoff.ts";

const SUBAGENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(SUBAGENT_TOOL_NAMES);
const PARENT_IDLE_CHECK_INTERVAL = "50 millis";

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
  readonly toolRuntime: SubagentToolRuntime;
}

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
  const replay = registerCodePreviewReplay(pi, {
    command: "subagents",
    tools: [...SUBAGENT_TOOL_NAME_SET],
  });
  const receipts = registerSubagentErrorReceipts(pi);
  const userInput = registerUserInputSignal(pi);
  const bridge = subagentProjectionBridge(pi.events);
  const profileOverrideHandoff = createProfileOverrideHandoff();
  const sessionFooter = subagentSessionFooter(pi.events);
  let releaseActivity: (() => void) | undefined;
  let currentActivation: CapturedActivation | undefined;
  const wake = registerParentWake(pi, {
    projection: bridge.get,
    drain: () =>
      currentActivation
        ? slot
            .run(SubagentService.use((service) => service.awaitParentDrain))
            .catch(() => undefined)
        : undefined,
    isIdle: () => currentActivation?.ctx.isIdle() ?? false,
    later: (check) => {
      slot.fork(Effect.sleep(PARENT_IDLE_CHECK_INTERVAL).pipe(Effect.andThen(Effect.sync(check))));
    },
  });
  let reportArchive: ReportArchive | undefined;
  const notify = hostNotifier(pi, {
    delivery: wake,
    archive: () => reportArchive,
  });
  let startupFailureTools: ReadonlyArray<string> = [];
  let hasRegisteredTools = false;
  let incompatibleReload = false;
  let retainingTools = false;

  const disableTools = (): void => {
    startupFailureTools = [...new Set([...startupFailureTools, ...deactivateSubagentTools(pi)])];
  };
  const showSessionFooter = (): void => {
    const session = profileOverrideHandoff.captureSnapshot();
    if (currentActivation && session) sessionFooter.show(currentActivation.ctx, session);
  };
  const detachActivation = (keepTools: boolean): void => {
    receipts.deactivate();
    releaseActivity?.();
    releaseActivity = undefined;
    if (!keepTools) disableTools();
    currentActivation = undefined;
    sessionFooter.clear();
    bridge.clear();
  };
  registerActiveRunsPrompt(pi, () => (currentActivation ? bridge.get() : undefined));
  registerDelegationPrompt(pi, () =>
    currentActivation
      ? profileOverrideHandoff.captureSnapshot()?.effectiveConfig.delegation
      : undefined,
  );
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
        const ownsActivation = slot.captureAuthority();
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
        const layer = subagentApplicationLayer({
          sessionKey: activation.sessionKey,
          sweepPrivateState: activation.trigger === "start",
          cwd: activation.cwd,
          agentDirectory: activation.agentDirectory,
          projectTrusted: activation.projectTrusted,
          ...(sessionBaseConfig && { sessionBaseConfig }),
          publishSessionBaseConfig: (config) =>
            profileOverrideHandoff.publishBaseConfig(owner, config),
          initialSessionOverrides: restoredReload ?? profileOverrideHandoff.capture(),
          publishSession: (snapshot) => {
            profileOverrideHandoff.publishSnapshot(owner, snapshot);
            if (ownsActivation() && currentActivation === activation) showSessionFooter();
          },
          publish: (projection) => {
            if (ownsActivation()) bridge.publish(projection);
          },
          restoredSessionUsage: restoreSessionUsage(activation.ctx),
          // Not gated on activation authority: runs closed while this runtime is replaced still
          // spent their usage in this session.
          recordSessionUsage: sessionUsageRecorder(pi, activation.ctx),
          notify: (notification) =>
            ownsActivation() && currentActivation === activation
              ? notify(notification)
              : { deliveredCompletionKeys: [], actionAccepted: false },
          questionnaireHandler: (request, questionnaireOwner) =>
            Effect.suspend(() =>
              ownsActivation() && currentActivation === activation
                ? askParentQuestionnaire(
                    pi.events,
                    activation.ctx.sessionManager.getSessionId(),
                    request,
                    questionnaireOwner,
                  )
                : Effect.fail(
                    new InvalidSubagentRequestError({
                      code: "proxy_caller_disconnected",
                      message: "The subagent session was replaced.",
                    }),
                  ),
            ),
          proxyHandler: (service, callerRunId, request) =>
            Effect.gen(function* () {
              if (!ownsActivation() || currentActivation !== activation)
                return yield* new InvalidSubagentRequestError({
                  code: "proxy_caller_disconnected",
                  message: "The subagent session was replaced.",
                });
              const decoded = decodeSubagentProxyParent(request);
              if (decoded instanceof InvalidSubagentRequestError) return yield* decoded;
              const parent = decoded.parentContext
                ? yield* service.captureLaunchParent(callerRunId, decoded.parentContext)
                : undefined;
              const input = decodeSubagentProxyRequest(decoded.request);
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
                {
                  cwd: caller.cwd,
                  projectTrusted: activation.projectTrusted,
                  ...(parent && { parentContext: parent.parentContext }),
                },
                input,
                undefined,
                activation.ctx,
                callerRunId,
                undefined,
                false,
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
          // The start schema lists the agents this activation's configuration declares.
          const profiles = yield* SubagentProfileService.use((service) => service.capture);
          return {
            scheduler,
            projection,
            toolRuntime: {
              environment: {
                cwd: activation.cwd,
                projectTrusted: activation.projectTrusted,
              },
              agents: profiles.effectiveConfig.agents,
              toolPresentation: bridge.bindToolPresentation(),
              run: slot.run,
            },
          };
        }),
      onActivated: (activation, token, prepared) => {
        if (!slot.isCurrent(token)) return;
        const run: typeof slot.run = (effect, signal) =>
          slot.isCurrent(token)
            ? slot.run(effect, signal)
            : Promise.reject(new Error("Subagents session was replaced."));
        try {
          const scheduleAnimation = (interval: number, tick: () => void) =>
            slot.isCurrent(token) ? prepared.scheduler.schedule(interval, tick) : undefined;
          const keptActive = new Set(activeSubagentTools(pi));
          registerSubagentTools(
            pi,
            { ...prepared.toolRuntime, scheduleAnimation, run, userInput },
            { receipts, owner: receipts.activate() },
            replay.shell,
          );
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
          if (slot.isCurrent(token)) slot.shutdown().catch(() => undefined);
          return;
        }
        if (!slot.isCurrent(token)) {
          disableTools();
          return;
        }
        if (activation.trigger !== "tree") replay.publish();
        bridge.publish(prepared.projection);
        currentActivation = activation;
        if (activation.sessionKey)
          reportArchive = sessionReportArchive(activation.agentDirectory, activation.sessionKey);
        showSessionFooter();
        if (activation.trigger === "reload" && activation.sessionKey)
          profileReloadHandoff.clear(activation.sessionKey);
        bridge.setContext(activation.ctx);
        reactivateSubagentTools(pi, startupFailureTools);
        startupFailureTools = [];
        const isCurrent = () => slot.isCurrent(token) && currentActivation === activation;
        // Once per session start, in the background; the notice reaches only the user.
        if (activation.trigger === "start")
          run(SubagentService.use((service) => service.sweepOrphanedWorkspaces))
            .then((swept) => {
              if (
                swept.length > 0 &&
                isCurrent() &&
                invokeHostCallback(() => activation.ctx.hasUI, false)
              )
                notifyAtHostBoundary(activation.ctx, orphanSweepNotice(swept), "info");
              return undefined;
            })
            .catch(() => undefined);
        if (activation.sessionKey && slot.isCurrent(token))
          releaseActivity = registerSubagentActivity({
            events: pi.events,
            sessionId: activation.sessionKey,
            bridge,
            isCurrent,
            input: (selected, action, signal) =>
              slot.run(promptSubagentActivityInput(activation.ctx, selected, action), signal),
            act: (id, action, signal, input, expected) =>
              slot.run(
                SubagentService.use((service) =>
                  runSubagentActivityAction(service, id, action, input, expected, () => {
                    if (isCurrent())
                      notifyAtHostBoundary(
                        activation.ctx,
                        "Guidance delivery is still pending",
                        "warning",
                      );
                  }),
                ),
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
    run: slot.run,
    current: () => currentActivation,
    isActive: () => slot.isActive(),
  });

  const prepareActivation = (ctx: ExtensionContext, trigger: ActivationTrigger): Promise<void> => {
    const tree = trigger === "tree";
    detachActivation(tree);
    const captured = captureSessionHost(ctx);
    if (!Predicate.isTagged(captured, "Captured")) return slot.shutdown();
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

  // Reloading or leaving the session stops every run, so first append pending reports without a
  // turn, then tell the model and the user which runs stop.
  const retireActivation = (ctx: ExtensionContext, cause: RuntimeRetirement): Promise<void> => {
    if (!currentActivation) return Promise.resolve();
    return slot
      .run(
        SubagentService.use((service) =>
          service.deliverPendingCompletions.pipe(Effect.timeoutOption("2 seconds")),
        ),
      )
      .catch(() => undefined)
      .then(() =>
        currentActivation
          ? reportStoppedRuns(pi, ctx, runsStoppedByReplacement(bridge.get().runs), cause)
          : undefined,
      );
  };

  // Pi switches the branch before this event. The runs belong to the branch the user left, so they
  // stop without appending their reports or a notice to the new one; only the user is told.
  pi.on("session_tree", (_event, ctx) => {
    const stopped = currentActivation ? runsStoppedByReplacement(bridge.get().runs) : [];
    return prepareActivation(ctx, "tree").then(() => notifyStoppedRuns(ctx, stopped));
  });

  const shutdownSession = (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    const reload = event.reason === "reload";
    replay.retire();
    const sessionKey = profileReloadSessionKey(ctx) ?? currentActivation?.sessionKey;
    detachActivation(reload);
    if (reload) {
      const authoritative = profileOverrideHandoff.captureAuthoritative();
      if (sessionKey && authoritative) profileReloadHandoff.publish(sessionKey, authoritative);
    } else profileReloadHandoff.clear();
    profileOverrideHandoff.clear();
    return reload ? retainingToolsDuring(() => slot.shutdown()) : slot.shutdown();
  };

  pi.on("session_shutdown", (event, ctx) => {
    wake.hold();
    return retireActivation(ctx, event.reason === "reload" ? "reload" : "session").then(() =>
      shutdownSession(event, ctx),
    );
  });
}
