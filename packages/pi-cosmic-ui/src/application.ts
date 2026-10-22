import * as Predicate from "effect/Predicate";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import {
  captureHostSignal,
  forwardAbortSignal,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import { capturedHostSignal } from "./boundary/host-abort-signal.ts";
import {
  decodeCompletedAssistantOutput,
  emptyTotals,
  readSessionUsageTotals,
} from "./boundary/host-usage.ts";
import { shutdownHostUiTickers } from "./boundary/host-status.ts";
import { defaultResolvedCosmicUiConfig, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import { createFooterRegistry } from "./footer/registry.ts";
import {
  cosmicUiApplicationLayer,
  type CosmicUiApplication,
  type CosmicUiRuntimeError,
  type CosmicUiSessionInput,
} from "./layer.ts";
import { CosmicUiService, createProjection, resetProjection } from "./protocol/service.ts";
import {
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "./protocol/protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";
import { createFooterInstallation } from "./footer/installation.ts";
import { createWorkingRow, type WorkingRowOptions } from "./working/row.ts";
import { ActivityService, type ActivityServiceContract } from "./activity/service.ts";
import { createActivityHost } from "./boundary/host-activity.ts";

export interface CosmicUiApplicationDependencies {
  readonly shutdownHostUiTickers?: () => Promise<void>;
  readonly workingRow?: WorkingRowOptions;
}

const applyProtocolEvent = <E>(parse: () => E | undefined, apply: (event: E) => void): void => {
  const parsed = invokeHostCallback(parse, undefined);
  if (parsed) apply(parsed);
};

const sessionCwd = (ctx: ExtensionContext) =>
  invokeHostCallback(() => {
    const cwd = ctx.cwd;
    return Predicate.isString(cwd) && cwd.length > 0 ? cwd : undefined;
  }, undefined);

export function registerCosmicUiApplication(
  pi: ExtensionAPI,
  dependencies: CosmicUiApplicationDependencies = {},
): void {
  const shutdownTickers = dependencies.shutdownHostUiTickers ?? shutdownHostUiTickers;
  const projection = createProjection();
  const workingRow = createWorkingRow(dependencies.workingRow);
  let activatedToken: number | undefined;
  let lifecycleGeneration = 0;
  let currentSession: Pick<CosmicUiSessionInput, "context" | "sessionManager"> | undefined;
  let currentPublicationOwner: MutableRef.MutableRef<boolean> | undefined;
  let subscriptions: Array<() => void> = [];
  let publishedHostState: string | undefined;

  const config = (): ResolvedCosmicUiConfig =>
    MutableRef.get(projection).config ?? defaultResolvedCosmicUiConfig();
  /**
   * Admits a context only from the session that started the current one, by its immutable session
   * manager, so late events from a replaced session cannot redirect the replacement's reads.
   */
  const updateContext = (ctx: ExtensionContext): boolean => {
    const session = currentSession;
    if (
      session === undefined ||
      !invokeHostCallback(() => ctx.sessionManager === session.sessionManager, false)
    )
      return false;
    MutableRef.set(session.context, ctx);
    return true;
  };
  const hostState = () => ({
    active: footerInstallation.isActive(),
    ready: activatedToken !== undefined,
    hidden: [...config().footer.hidden],
  });
  const publishHostState = () => {
    const state = { version: COSMIC_UI_PROTOCOL_VERSION, ...hostState() };
    const key = JSON.stringify(state);
    if (publishedHostState === key) return;
    publishedHostState = key;
    invokeHostCallback(() => pi.events.emit(COSMIC_UI_HOST_STATE, state), undefined);
  };
  const registry = createFooterRegistry({
    requestRender: () => footerInstallation.requestRender(),
    sessionActive: () => activatedToken !== undefined,
  });
  const footerInstallation = createFooterInstallation({
    pi,
    registry,
    projection,
    config,
    currentContext: () => (currentSession ? MutableRef.get(currentSession.context) : undefined),
    refreshAfterBranchChange: (ctx) => {
      forkFrom(
        CosmicUiService.use((service) =>
          service.invalidateProbes().pipe(Effect.andThen(service.refreshAll(true))),
        ),
        ctx,
      );
    },
    onActiveChange: publishHostState,
  });

  const retirePublication = (owner = currentPublicationOwner) => {
    if (owner) MutableRef.set(owner, false);
    if (currentPublicationOwner === owner) currentPublicationOwner = undefined;
  };
  const slot = makePiSessionRuntimeSlot<
    CosmicUiSessionInput,
    CosmicUiApplication,
    never,
    CosmicUiRuntimeError,
    ActivityServiceContract
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        cosmicUiApplicationLayer(input, {
          projection,
          requestRender: () => {
            footerInstallation.requestRender();
            publishHostState();
          },
          invalidateContextUsage: footerInstallation.invalidateContextUsage,
          activityHost,
        }),
        { agentDirectory: getAgentDir, packageName: "pi-cosmic-ui" },
      ),
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        return yield* ActivityService;
      }),
    onActivated: ({ ctx, context, sessionManager, signal }, token, activity) => {
      activatedToken = token;
      currentSession = { context, sessionManager };
      workingRow.activate(context);
      invokeHostCallback(() => activityHost.activate(ctx, activity), undefined);
      footerInstallation.update(ctx);
      publishHostState();
      slot.fork(
        CosmicUiService.use((service) => service.refreshAll(true)),
        signal,
      );
    },
    onDeactivated: ({ context, releaseSignal, publicationOwner }, token) => {
      retirePublication(publicationOwner);
      releaseSignal();
      if (currentSession?.context === context) currentSession = undefined;
      workingRow.deactivate();
      activityHost.deactivate();
      footerInstallation.uninstall();
      if (activatedToken === token) {
        activatedToken = undefined;
        registry.clear();
      }
      publishHostState();
    },
    onStartFailure: ({ ctx }) => notifyAtHostBoundary(ctx, "Cosmic UI couldn't start", "warning"),
  });

  const activityHost = createActivityHost(
    pi,
    (effect, signal) => {
      slot.fork(effect.pipe(Effect.ignore), signal);
    },
    slot.run,
  );
  pi.registerCommand("activity", {
    description: "Browse session activity and actions",
    handler: (_args, ctx) => runFrom(activityHost.open(ctx).pipe(Effect.ignore), ctx),
  });

  const runFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) =>
    slot.run(effect, capturedHostSignal(ctx));
  const forkFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) =>
    slot.fork(effect, capturedHostSignal(ctx));
  const forkGitRefresh = (ctx: ExtensionContext, force?: boolean) =>
    forkFrom(
      CosmicUiService.use((service) => service.refreshGit(force)),
      ctx,
    );

  const ensureSubscriptions = () => {
    if (subscriptions.length > 0) return;
    subscriptions = [
      pi.events.on(COSMIC_UI_HOST_QUERY, (data) =>
        applyProtocolEvent(
          () => normalizeCosmicUiHostQuery(data),
          (query) => invokeHostCallback(() => query.respond(hostState()), undefined),
        ),
      ),
      pi.events.on(COSMIC_UI_FOOTER_UPSERT, (data) =>
        applyProtocolEvent(
          () => normalizeCosmicFooterUpsertEvent(data),
          (event) => registry.upsert(event.owner, event.contribution),
        ),
      ),
      pi.events.on(COSMIC_UI_FOOTER_REMOVE, (data) =>
        applyProtocolEvent(
          () => normalizeCosmicFooterRemoveEvent(data),
          (event) => registry.remove(event.owner, event.id),
        ),
      ),
    ];
  };
  ensureSubscriptions();

  registerSettingsCommand(pi, {
    config,
    updateContext,
    update: footerInstallation.update,
    run: slot.run,
    captureAuthority: slot.captureAuthority,
  });

  const beginLifecycle = () => {
    retirePublication();
    return ++lifecycleGeneration;
  };
  const clearRetired = (generation: number, clearRegistry: boolean) => {
    if (generation !== lifecycleGeneration) return;
    currentSession = undefined;
    if (clearRegistry) registry.clear();
    resetProjection(projection);
  };

  const settleFailedStartup = (
    context: MutableRef.MutableRef<ExtensionContext>,
    publicationOwner: MutableRef.MutableRef<boolean>,
    releaseSignal: () => void,
  ): void => {
    retirePublication(publicationOwner);
    if (currentSession?.context === context) currentSession = undefined;
    releaseSignal();
  };

  pi.on("session_start", (_event, ctx) => {
    const generation = beginLifecycle();
    const cwd = sessionCwd(ctx);
    const sessionManager =
      cwd === undefined ? undefined : invokeHostCallback(() => ctx.sessionManager, undefined);
    const captured = sessionManager === undefined ? undefined : captureHostSignal(ctx);
    const host = captured && Predicate.isTagged(captured, "Captured") ? captured : undefined;
    const abort = host?.signal === undefined ? undefined : forwardAbortSignal(host.signal);
    if (
      cwd === undefined ||
      sessionManager === undefined ||
      host === undefined ||
      abort?.signal.aborted
    ) {
      abort?.release();
      return slot.shutdown().then(() => clearRetired(generation, false));
    }
    const releaseSignal = abort?.release ?? (() => undefined);
    const projectTrusted = isProjectTrusted(ctx);
    ensureSubscriptions();
    footerInstallation.uninstall();
    const initialTotals = readSessionUsageTotals(sessionManager) ?? emptyTotals();
    resetProjection(projection, initialTotals);
    const context = MutableRef.make(ctx);
    currentSession = { context, sessionManager };
    const publicationOwner = MutableRef.make(true);
    currentPublicationOwner = publicationOwner;
    return slot
      .start(
        {
          ctx,
          context,
          sessionManager,
          cwd,
          signal: abort?.signal,
          releaseSignal,
          initialTotals,
          projectTrusted,
          publicationOwner,
        },
        abort?.signal,
      )
      .then((token) =>
        token === undefined
          ? settleFailedStartup(context, publicationOwner, releaseSignal)
          : undefined,
      );
  });

  /** Repaints at once; the service reconciles persisted totals and repaints if they changed. */
  const refreshUsage = (ctx: ExtensionContext, refreshGit: boolean) => {
    if (!updateContext(ctx)) return undefined;
    footerInstallation.invalidateContextUsage();
    footerInstallation.requestRender();
    const reconciled = runFrom(
      CosmicUiService.use((service) => service.reconcileUsage()),
      ctx,
    ).catch(() => undefined);
    if (refreshGit) forkGitRefresh(ctx);
    return reconciled;
  };
  pi.on("turn_end", (_event, ctx) => refreshUsage(ctx, true));
  pi.on("session_compact", (_event, ctx) => refreshUsage(ctx, false));
  pi.on("session_tree", (_event, ctx) => refreshUsage(ctx, false));
  pi.on("agent_settled", (_event, ctx) => refreshUsage(ctx, false));
  const renderUpdatedContext = (ctx: ExtensionContext) => {
    if (updateContext(ctx)) footerInstallation.requestRender();
  };
  const invalidateContextUsage = (ctx: ExtensionContext) => {
    if (!updateContext(ctx)) return;
    footerInstallation.invalidateContextUsage();
    footerInstallation.requestRender();
  };
  pi.on("model_select", (_event, ctx) => invalidateContextUsage(ctx));
  pi.on("tool_execution_start", (_event, ctx) => {
    updateContext(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (updateContext(ctx) && ["bash", "edit", "write"].includes(event.toolName))
      forkGitRefresh(ctx, true);
  });
  pi.on("thinking_level_select", (_event, ctx) => renderUpdatedContext(ctx));
  pi.on("session_info_changed", (_event, ctx) => renderUpdatedContext(ctx));
  pi.on("agent_start", (_event, ctx) => {
    invalidateContextUsage(ctx);
    workingRow.agentStart();
  });
  pi.on("agent_end", (_event, ctx) => {
    updateContext(ctx);
    workingRow.agentEnd();
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!workingRow.canPrompt()) return;
    updateContext(ctx);
    workingRow.promptStart();
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!workingRow.isPrompting()) return;
    updateContext(ctx);
    workingRow.promptEnd();
  });
  pi.on("context_with_system", () => {
    workingRow.callStart();
  });
  pi.on("message_start", (_event, ctx) => invalidateContextUsage(ctx));
  pi.on("message_update", (event, ctx) => {
    invalidateContextUsage(ctx);
    const update = event.assistantMessageEvent;
    if (
      !update ||
      (update.type !== "text_delta" &&
        update.type !== "thinking_delta" &&
        update.type !== "toolcall_delta")
    )
      return;
    workingRow.output(update.delta.length);
  });
  pi.on("message_end", (event, ctx) => {
    updateContext(ctx);
    if (event.message?.role === "assistant")
      workingRow.callEnd(decodeCompletedAssistantOutput(event.message));
    invalidateContextUsage(ctx);
  });
  pi.on("session_shutdown", () => {
    const generation = beginLifecycle();
    footerInstallation.uninstall();
    for (const unsubscribe of subscriptions.splice(0)) invokeHostCallback(unsubscribe, undefined);
    return Promise.all([slot.shutdown(), shutdownTickers()]).then(() =>
      clearRetired(generation, true),
    );
  });
}
