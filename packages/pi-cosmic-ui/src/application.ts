/** Cosmic UI host with one Effect-managed runtime per Pi session. */
import * as Predicate from "effect/Predicate";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { isProjectTrusted, makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import {
  makeHostCallbackBoundary,
  snapshotHostAbortSignal,
  type HostCallbackOperation,
} from "./boundary/host-callback.ts";
import { addAssistantUsage, decodeAssistantUsage } from "./boundary/host-usage.ts";
import { shutdownHostUiTickers, startHostUiTicker } from "./boundary/host-status.ts";
import { makeDefaultResolvedCosmicUiConfig, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import type { FooterTotals } from "./footer/builtin-contributions.ts";
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
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterInvalidateEvent,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "./protocol/protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";
import { createFooterInstallation } from "./footer/installation.ts";
import { makeWorkingRow } from "./working/row.ts";
import { ActivityService, type ActivityServiceContract } from "./activity/service.ts";
import { makeActivityHost } from "./boundary/host-activity.ts";

const TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"] as const;

export interface CosmicUiApplicationDependencies {
  readonly shutdownHostUiTickers?: () => Promise<void>;
}

/** `dependencies` is an internal seam for host-lifecycle cleanup tests. */
export function registerCosmicUiApplication(
  pi: ExtensionAPI,
  dependencies: CosmicUiApplicationDependencies = {},
): void {
  const callbacks = makeHostCallbackBoundary();
  const shutdownTickers = dependencies.shutdownHostUiTickers ?? shutdownHostUiTickers;
  let activatedToken: number | undefined;
  const registry = makeFooterRegistry({
    requestRender: () => footerInstallation.requestRender(),
    sessionActive: () => activatedToken !== undefined,
  });
  const projection = makeProjection();
  const workingRow = makeWorkingRow({ callbacks });
  const sessionCwd = (ctx: ExtensionContext) =>
    callbacks.invoke<string | undefined>(
      "host-query",
      () => {
        const value = ctx.cwd;
        if (!Predicate.isString(value) || value.length === 0)
          throw new Error("Invalid session cwd.");
        return value;
      },
      undefined,
    );
  let lifecycleGeneration = 0;
  let stopUsageTicker: (() => void) | undefined;
  let lastCompleteTotals = emptyTotals();
  let usageSessionManager: ExtensionContext["sessionManager"] | undefined;
  const resetTotals = () => {
    usageSessionManager = undefined;
    lastCompleteTotals = emptyTotals();
  };
  const totalsFromSession = (ctx: ExtensionContext): FooterTotals => {
    const generation = lifecycleGeneration;
    const read = callbacks.invoke<FooterTotals | undefined>(
      "host-query",
      () => {
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
          if (usage === undefined) throw new Error("Invalid assistant usage.");
          const next = addAssistantUsage(totals, usage);
          if (next === undefined) throw new Error("Assistant usage totals overflowed.");
          totals = next;
        }
        return totals;
      },
      undefined,
    );
    if (read === undefined || generation !== lifecycleGeneration) return lastCompleteTotals;
    lastCompleteTotals = read;
    return read;
  };
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let currentPublicationOwner: MutableRef.MutableRef<boolean> | undefined;
  const revokePublication = () => {
    if (currentPublicationOwner) MutableRef.set(currentPublicationOwner, false);
    currentPublicationOwner = undefined;
  };
  const captureAuthority = () => {
    const owner = currentPublicationOwner;
    return () =>
      owner === undefined ? currentPublicationOwner === undefined : MutableRef.get(owner);
  };
  let subscriptions: Array<() => void> = [];
  const ownsUsageContext = (ctx: ExtensionContext) =>
    callbacks.invoke(
      "host-query",
      () =>
        currentContext !== undefined &&
        usageSessionManager !== undefined &&
        usageSessionManager === ctx.sessionManager,
      false,
    );

  const config = (): ResolvedCosmicUiConfig =>
    MutableRef.get(projection).config ?? makeDefaultResolvedCosmicUiConfig();
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  let footerInstallation!: ReturnType<typeof createFooterInstallation>;
  let publishedHostState: string | undefined;
  const hostState = () => ({
    active: footerInstallation.isActive(),
    ready: currentContext !== undefined,
    hidden: [...config().footer.hidden],
  });
  const publishHostState = () => {
    if (!footerInstallation) return;
    const state = { version: COSMIC_UI_PROTOCOL_VERSION, ...hostState() };
    const key = JSON.stringify(state);
    if (publishedHostState === key) return;
    publishedHostState = key;
    callbacks.invoke("host-query", () => pi.events.emit(COSMIC_UI_HOST_STATE, state), undefined);
  };
  const requestRender = () => {
    footerInstallation.requestRender();
    publishHostState();
  };
  const notifyStartFailure = (ctx: ExtensionContext) =>
    callbacks.invoke(
      "notify",
      () => ctx.ui.notify("Cosmic UI couldn't start", "warning"),
      undefined,
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
          callbacks,
          projection,
          requestRender,
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
      callbacks.invoke("host-query", () => activityHost.activate(ctx, activity), undefined);
      footerInstallation.update(ctx);
      publishHostState();
      slot.fork(
        CosmicUiService.use((service) => service.refreshAll(true)),
        signal,
      );
    },
    onDeactivated: ({ context, releaseSignal, publicationOwner }, token) => {
      MutableRef.set(publicationOwner, false);
      if (currentPublicationOwner === publicationOwner) currentPublicationOwner = undefined;
      releaseSignal();
      if (currentContext === context) currentContext = undefined;
      workingRow.deactivate();
      activityHost.deactivate();
      footerInstallation.uninstall();
      // A start that never activated keeps pre-session contributions for the next start.
      if (activatedToken === token) {
        activatedToken = undefined;
        registry.clear();
      }
      publishHostState();
    },
    onStartFailure: ({ ctx, releaseSignal, publicationOwner }) => {
      MutableRef.set(publicationOwner, false);
      if (currentPublicationOwner === publicationOwner) currentPublicationOwner = undefined;
      releaseSignal();
      notifyStartFailure(ctx);
    },
  });

  const activityHost = makeActivityHost(pi, (effect, signal) => {
    slot.fork(effect.pipe(Effect.ignore), signal);
  });
  pi.registerCommand("activity", {
    description: "Browse session activity and actions",
    handler: (_args, ctx) => runFrom(activityHost.open(ctx).pipe(Effect.ignore), ctx),
  });

  const runFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const result = slot.run(effect, abort?.signal);
    return abort ? result.finally(abort.release) : result;
  };
  const forkFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const guarded = abort ? effect.pipe(Effect.ensuring(Effect.sync(abort.release))) : effect;
    const fiber = slot.fork(guarded, abort?.signal);
    if (!fiber) abort?.release();
    return fiber;
  };
  footerInstallation = createFooterInstallation({
    pi,
    callbacks,
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

  const onProtocolEvent = <E>(
    event: string,
    operation: HostCallbackOperation,
    normalize: <Raw>(raw: Raw) => E | undefined,
    apply: (event: E) => void,
  ): (() => void) =>
    pi.events.on(event, (data) => {
      const parsed = callbacks.invoke(operation, () => normalize(data), undefined);
      if (parsed) apply(parsed);
    });

  const ensureSubscriptions = () => {
    if (subscriptions.length > 0) return;
    subscriptions = [
      pi.events.on(COSMIC_UI_HOST_QUERY, (data) => {
        const query = callbacks.invoke(
          "host-query",
          () => normalizeCosmicUiHostQuery(data),
          undefined,
        );
        if (query) callbacks.invoke("host-query", () => query.respond(hostState()), undefined);
      }),
      onProtocolEvent(
        COSMIC_UI_FOOTER_UPSERT,
        "protocol-upsert",
        normalizeCosmicFooterUpsertEvent,
        (event) => registry.upsert(event.owner, event.contribution),
      ),
      onProtocolEvent(
        COSMIC_UI_FOOTER_REMOVE,
        "protocol-remove",
        normalizeCosmicFooterRemoveEvent,
        (event) => registry.remove(event.owner, event.id),
      ),
      onProtocolEvent(
        COSMIC_UI_FOOTER_INVALIDATE,
        "protocol-invalidate",
        normalizeCosmicFooterInvalidateEvent,
        () => registry.invalidate(),
      ),
    ];
  };
  const disposeSubscriptions = () => {
    for (const unsubscribe of subscriptions.splice(0))
      callbacks.invoke("event-unsubscribe", unsubscribe, undefined);
  };
  ensureSubscriptions();

  registerSettingsCommand(pi, {
    config,
    updateContext,
    update: footerInstallation.update,
    run: slot.run,
    captureAuthority,
    callbacks,
  });

  pi.on("session_start", (_event, ctx) => {
    // Revoke before resetting projections or awaiting disposal, including pending starts.
    revokePublication();
    const generation = ++lifecycleGeneration;
    stopUsageTicker?.();
    stopUsageTicker = undefined;
    const shutdownFailedStart = () =>
      slot.shutdown().then(() => {
        if (generation !== lifecycleGeneration) return;
        currentContext = undefined;
        resetTotals();
        resetProjection(projection);
      });
    const cwd = sessionCwd(ctx);
    const abort =
      cwd === undefined ? undefined : snapshotHostAbortSignal(callbacks, () => ctx.signal);
    if (cwd === undefined || abort === undefined) return shutdownFailedStart();
    if (abort.aborted) {
      abort.release();
      return shutdownFailedStart();
    }
    const projectTrusted = isProjectTrusted(ctx);
    ensureSubscriptions();
    footerInstallation.uninstall();
    resetTotals();
    usageSessionManager = callbacks.invoke("host-query", () => ctx.sessionManager, undefined);
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
      .then(
        (token) => {
          if (token !== undefined && generation === lifecycleGeneration) {
            stopUsageTicker = startHostUiTicker(1_000, () => {
              if (generation === lifecycleGeneration && currentContext === context)
                void refreshUsage(MutableRef.get(context), "idle");
            });
          }
          if (token === undefined) {
            MutableRef.set(publicationOwner, false);
            if (currentPublicationOwner === publicationOwner) currentPublicationOwner = undefined;
            // A superseded start never activates: stop publishing this dead context
            // unless a newer start already replaced it.
            if (currentContext === context) currentContext = undefined;
            abort.release();
          }
        },
        () => {
          MutableRef.set(publicationOwner, false);
          if (currentPublicationOwner === publicationOwner) currentPublicationOwner = undefined;
          if (currentContext === context) currentContext = undefined;
          abort.release();
          notifyStartFailure(ctx);
        },
      );
  });

  const refreshUsage = (ctx: ExtensionContext, kind: "turn" | "rescan" | "idle") => {
    if (!ownsUsageContext(ctx)) return;
    if (kind === "turn") updateContext(ctx);
    const previous = lastCompleteTotals;
    const totals = totalsFromSession(ctx);
    if (kind === "idle" && TOTAL_KEYS.every((key) => totals[key] === previous[key])) return;
    if (kind !== "turn") updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
    const generation = lifecycleGeneration;
    return runFrom(
      CosmicUiService.use((service) =>
        kind === "turn"
          ? service.setTotals(totals).pipe(Effect.andThen(service.refreshGit()))
          : generation === lifecycleGeneration
            ? service.setTotals(totals)
            : Effect.void,
      ),
      ctx,
    ).catch(() => undefined);
  };
  pi.on("turn_end", (_event, ctx) => refreshUsage(ctx, "turn"));
  pi.on("session_compact", (_event, ctx) => refreshUsage(ctx, "rescan"));
  pi.on("session_tree", (_event, ctx) => refreshUsage(ctx, "rescan"));
  pi.on("agent_settled", (_event, ctx) => refreshUsage(ctx, "rescan"));
  const invalidateContextUsage = <Event>(_event: Event, ctx: ExtensionContext) => {
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
  };
  pi.on("model_select", invalidateContextUsage);
  pi.on("tool_execution_start", (_event, ctx) => {
    updateContext(ctx);
    workingRow.pauseOutput();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    updateContext(ctx);
    if (!["bash", "edit", "write"].includes(event.toolName)) return;
    return runFrom(
      CosmicUiService.use((service) => service.refreshGit(true)),
      ctx,
    ).catch(() => undefined);
  });
  const renderUpdatedContext = <Event>(_event: Event, ctx: ExtensionContext) => {
    updateContext(ctx);
    requestRender();
  };
  pi.on("thinking_level_select", renderUpdatedContext);
  pi.on("session_info_changed", renderUpdatedContext);
  pi.on("agent_start", (event, ctx) => {
    invalidateContextUsage(event, ctx);
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
  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", (event, ctx) => {
    invalidateContextUsage(event, ctx);
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
    invalidateContextUsage(event, ctx);
    workingRow.pauseOutput();
  });
  pi.on("session_shutdown", () => {
    revokePublication();
    const generation = ++lifecycleGeneration;
    stopUsageTicker?.();
    stopUsageTicker = undefined;
    usageSessionManager = undefined;
    footerInstallation.uninstall();
    disposeSubscriptions();
    return Promise.all([slot.shutdown(), shutdownTickers()]).then(() => {
      if (generation !== lifecycleGeneration) return;
      currentContext = undefined;
      resetTotals();
      registry.clear();
      resetProjection(projection);
    });
  });
}
