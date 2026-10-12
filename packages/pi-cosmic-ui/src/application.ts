import * as Predicate from "effect/Predicate";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import {
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import { capturedHostSignal, snapshotHostAbortSignal } from "./boundary/host-abort-signal.ts";
import {
  addAssistantUsage,
  decodeAssistantUsage,
  decodeCompletedAssistantOutput,
  type FooterTotals,
} from "./boundary/host-usage.ts";
import { shutdownHostUiTickers, startHostUiTicker } from "./boundary/host-status.ts";
import { makeDefaultResolvedCosmicUiConfig, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import { makeFooterRegistry } from "./footer/registry.ts";
import {
  makeCosmicUiApplicationLayer,
  type CosmicUiApplication,
  type CosmicUiRuntimeError,
  type CosmicUiSessionInput,
} from "./layer.ts";
import {
  CosmicUiService,
  emptyTotals,
  makeProjection,
  resetProjection,
} from "./protocol/service.ts";
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
import { makeWorkingRow, type WorkingRowOptions } from "./working/row.ts";
import { ActivityService, type ActivityServiceContract } from "./activity/service.ts";
import { makeActivityHost } from "./boundary/host-activity.ts";

const TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

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
  const projection = makeProjection();
  const workingRow = makeWorkingRow(dependencies.workingRow);
  let activatedToken: number | undefined;
  let lifecycleGeneration = 0;
  let stopUsageTicker: (() => void) | undefined;
  let lastCompleteTotals = emptyTotals();
  let usageSessionManager: ExtensionContext["sessionManager"] | undefined;
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let currentPublicationOwner: MutableRef.MutableRef<boolean> | undefined;
  let subscriptions: Array<() => void> = [];
  let publishedHostState: string | undefined;

  const config = (): ResolvedCosmicUiConfig =>
    MutableRef.get(projection).config ?? makeDefaultResolvedCosmicUiConfig();
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
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
  const registry = makeFooterRegistry({
    requestRender: () => footerInstallation.requestRender(),
    sessionActive: () => activatedToken !== undefined,
  });
  const footerInstallation = createFooterInstallation({
    pi,
    registry,
    projection,
    config,
    currentContext: () => (currentContext ? MutableRef.get(currentContext) : undefined),
    refreshAfterBranchChange: (ctx) => {
      forkFrom(
        CosmicUiService.use((service) =>
          service.invalidateProbes.pipe(Effect.andThen(service.refreshAll(true))),
        ),
        ctx,
      );
    },
    onActiveChange: publishHostState,
  });

  const resetTotals = () => {
    usageSessionManager = undefined;
    lastCompleteTotals = emptyTotals();
  };
  const totalsFromSession = (ctx: ExtensionContext): FooterTotals => {
    const generation = lifecycleGeneration;
    const read = invokeHostCallback<FooterTotals | undefined>(() => {
      let totals = emptyTotals();
      for (const entry of ctx.sessionManager.getEntries()) {
        const rawUsage =
          entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
            ? entry.usage
            : entry.type === "message" &&
                (entry.message.role === "assistant" || entry.message.role === "toolResult")
              ? entry.message.usage
              : undefined;
        if (
          rawUsage === undefined &&
          !(
            entry.type === "usage" ||
            (entry.type === "message" && entry.message.role === "assistant")
          )
        )
          continue;
        const usage = decodeAssistantUsage(rawUsage);
        const next = usage && addAssistantUsage(totals, usage);
        if (next === undefined) return undefined;
        totals = next;
      }
      return totals;
    }, undefined);
    if (read === undefined || generation !== lifecycleGeneration) return lastCompleteTotals;
    lastCompleteTotals = read;
    return read;
  };
  const retirePublication = (owner = currentPublicationOwner) => {
    if (owner) MutableRef.set(owner, false);
    if (currentPublicationOwner === owner) currentPublicationOwner = undefined;
  };
  const ownsUsageContext = (ctx: ExtensionContext) =>
    invokeHostCallback(
      () =>
        currentContext !== undefined &&
        usageSessionManager !== undefined &&
        usageSessionManager === ctx.sessionManager,
      false,
    );

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
        makeCosmicUiApplicationLayer(input, {
          projection,
          requestRender: () => {
            footerInstallation.requestRender();
            publishHostState();
          },
          activityHost,
        }),
        { agentDirectory: getAgentDir, packageName: "pi-cosmic-ui" },
      ),
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        return yield* ActivityService;
      }),
    onActivated: ({ ctx, context, signal }, token, activity) => {
      activatedToken = token;
      currentContext = context;
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
      if (currentContext === context) currentContext = undefined;
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

  const activityHost = makeActivityHost(
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
    stopUsageTicker?.();
    stopUsageTicker = undefined;
    return ++lifecycleGeneration;
  };
  const clearRetired = (generation: number, clearRegistry: boolean) => {
    if (generation !== lifecycleGeneration) return;
    currentContext = undefined;
    resetTotals();
    if (clearRegistry) registry.clear();
    resetProjection(projection);
  };

  const settleStartup = (
    failed: boolean,
    generation: number,
    context: MutableRef.MutableRef<ExtensionContext>,
    publicationOwner: MutableRef.MutableRef<boolean>,
    releaseSignal: () => void,
  ): void => {
    if (failed) {
      retirePublication(publicationOwner);
      if (currentContext === context) currentContext = undefined;
      releaseSignal();
    } else if (generation === lifecycleGeneration) {
      stopUsageTicker = startHostUiTicker(1_000, () => {
        if (generation === lifecycleGeneration && currentContext === context)
          void refreshUsage(MutableRef.get(context), "idle");
      });
    }
  };

  pi.on("session_start", (_event, ctx) => {
    const generation = beginLifecycle();
    const cwd = sessionCwd(ctx);
    const abort = cwd === undefined ? undefined : snapshotHostAbortSignal(() => ctx.signal);
    if (cwd === undefined || abort === undefined || abort.aborted) {
      abort?.release();
      return slot.shutdown().then(() => clearRetired(generation, false));
    }
    const projectTrusted = isProjectTrusted(ctx);
    ensureSubscriptions();
    footerInstallation.uninstall();
    resetTotals();
    usageSessionManager = invokeHostCallback(() => ctx.sessionManager, undefined);
    const initialTotals = totalsFromSession(ctx);
    resetProjection(projection, initialTotals);
    const context = MutableRef.make(ctx);
    currentContext = context;
    const publicationOwner = MutableRef.make(true);
    currentPublicationOwner = publicationOwner;
    return slot
      .start(
        {
          ctx,
          context,
          cwd,
          signal: abort.signal,
          releaseSignal: abort.release,
          initialTotals,
          projectTrusted,
          publicationOwner,
        },
        abort.signal,
      )
      .then((token) =>
        settleStartup(token === undefined, generation, context, publicationOwner, abort.release),
      );
  });

  const refreshUsage = (ctx: ExtensionContext, kind: "turn" | "rescan" | "idle") => {
    if (!ownsUsageContext(ctx)) return undefined;
    const previous = lastCompleteTotals;
    const totals = totalsFromSession(ctx);
    if (kind === "idle" && TOTAL_KEYS.every((key) => totals[key] === previous[key]))
      return undefined;
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    footerInstallation.requestRender();
    const committed = runFrom(
      CosmicUiService.use((service) => service.setTotals(totals)),
      ctx,
    ).catch(() => undefined);
    if (kind === "turn") forkGitRefresh(ctx);
    return committed;
  };
  pi.on("turn_end", (_event, ctx) => refreshUsage(ctx, "turn"));
  pi.on("session_compact", (_event, ctx) => refreshUsage(ctx, "rescan"));
  pi.on("session_tree", (_event, ctx) => refreshUsage(ctx, "rescan"));
  pi.on("agent_settled", (_event, ctx) => refreshUsage(ctx, "rescan"));
  const renderUpdatedContext = (ctx: ExtensionContext) => {
    updateContext(ctx);
    footerInstallation.requestRender();
  };
  const invalidateContextUsage = (ctx: ExtensionContext) => {
    footerInstallation.invalidateContextUsage();
    renderUpdatedContext(ctx);
  };
  pi.on("model_select", (_event, ctx) => invalidateContextUsage(ctx));
  pi.on("tool_execution_start", (_event, ctx) => {
    updateContext(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    updateContext(ctx);
    if (["bash", "edit", "write"].includes(event.toolName)) forkGitRefresh(ctx, true);
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
    usageSessionManager = undefined;
    footerInstallation.uninstall();
    for (const unsubscribe of subscriptions.splice(0)) invokeHostCallback(unsubscribe, undefined);
    return Promise.all([slot.shutdown(), shutdownTickers()]).then(() =>
      clearRetired(generation, true),
    );
  });
}
