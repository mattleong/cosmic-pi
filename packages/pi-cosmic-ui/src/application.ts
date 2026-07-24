/** Cosmic UI host with one Effect-managed runtime per Pi session. */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { makeHostCallbackBoundary, snapshotHostAbortSignal } from "./boundary/host-callback.ts";
import { DEFAULT_CONFIG, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import type { FooterTotals } from "./footer/component.ts";
import {
  emptyFooterRegistrySnapshot,
  FooterRegistryService,
  type FooterRegistryBridge,
} from "./footer/registry.ts";
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
  FooterProtocolHost,
  makeFooterProtocolBuffer,
  protocolInvalidate,
  protocolRemove,
  protocolUpsert,
} from "./protocol/host.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  normalizeCosmicFooterInvalidateEvent,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "./protocol/protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";
import { createFooterInstallation } from "./footer/installation.ts";
import { WorkingTimerService } from "./working/service.ts";

const isProjectTrusted = (ctx: ExtensionContext): boolean => {
  try {
    return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  } catch {
    return false;
  }
};

export function registerCosmicUiApplication(pi: ExtensionAPI): void {
  const callbacks = makeHostCallbackBoundary();
  const protocolBuffer = makeFooterProtocolBuffer();
  const bridge: FooterRegistryBridge = {
    snapshot: emptyFooterRegistrySnapshot(),
    requestRenderNow: () => undefined,
    invalidate: (owner, id) => {
      protocolBuffer.offer({
        _tag: "Invalidate",
        ...(owner === undefined ? {} : { owner }),
        ...(id === undefined ? {} : { id }),
      });
    },
  };
  const projection = makeProjection();
  type SessionHostRead =
    | {
        readonly _tag: "Success";
        readonly cwd: string;
        readonly signal: AbortSignal | undefined;
        readonly aborted: boolean;
        readonly releaseSignal: () => void;
      }
    | { readonly _tag: "Failure" };
  const failedSessionHostRead: SessionHostRead = Object.freeze({ _tag: "Failure" });
  const sessionHostFrom = (ctx: ExtensionContext): SessionHostRead => {
    const cwd = callbacks.invoke<string | undefined>(
      "host-query",
      () => {
        const value = ctx.cwd;
        if (typeof value !== "string" || value.length === 0)
          throw new Error("Invalid session cwd.");
        return value;
      },
      undefined,
    );
    if (cwd === undefined) return failedSessionHostRead;
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    return abort === undefined
      ? failedSessionHostRead
      : {
          _tag: "Success",
          cwd,
          signal: abort.signal,
          aborted: abort.aborted,
          releaseSignal: abort.release,
        };
  };
  type TotalsRead =
    | { readonly _tag: "Success"; readonly totals: FooterTotals }
    | { readonly _tag: "Failure" };
  const failedTotalsRead: TotalsRead = Object.freeze({ _tag: "Failure" });
  let lastCompleteTotals = emptyTotals();
  const rememberTotals = (totals: FooterTotals) => {
    lastCompleteTotals = totals;
    return totals;
  };
  const resetTotals = () => {
    lastCompleteTotals = emptyTotals();
  };
  const totalsFromSession = (ctx: ExtensionContext): FooterTotals => {
    const read = callbacks.invoke<TotalsRead>(
      "host-query",
      () => {
        const totals = emptyTotals();
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;
          const usage = entry.message.usage;
          totals.input += usage.input;
          totals.output += usage.output;
          totals.cacheRead += usage.cacheRead;
          totals.cacheWrite += usage.cacheWrite;
          totals.cost += usage.cost.total;
        }
        return { _tag: "Success", totals };
      },
      failedTotalsRead,
    );
    return read._tag === "Success" ? rememberTotals(read.totals) : lastCompleteTotals;
  };
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let subscriptions: Array<() => void> = [];

  const config = (): ResolvedCosmicUiConfig =>
    MutableRef.get(projection).config ?? {
      configPath: "",
      projectConfigPath: "",
      globalConfigPath: "",
      footer: { ...DEFAULT_CONFIG.footer },
    };
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  const requestRender = () => bridge.requestRenderNow();
  let footerInstallation!: ReturnType<typeof createFooterInstallation>;

  const slot = makePiSessionRuntimeSlot<
    CosmicUiSessionInput,
    CosmicUiApplication,
    never,
    CosmicUiRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeCosmicUiApplicationLayer(input, {
          callbacks,
          bridge,
          projection,
          protocolBuffer,
          requestRender,
        }),
      ),
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        yield* FooterRegistryService;
        yield* FooterProtocolHost;
        yield* WorkingTimerService;
      }),
    onActivated: ({ ctx, context, signal }) => {
      currentContext = context;
      footerInstallation.update(ctx);
      slot.fork(
        CosmicUiService.use((service) => service.refreshAll(true)),
        signal,
      );
    },
    onDeactivated: ({ context, releaseSignal }) => {
      releaseSignal();
      if (currentContext === context) currentContext = undefined;
      footerInstallation.uninstall();
    },
    onStartFailure: ({ ctx, releaseSignal }) => {
      releaseSignal();
      callbacks.invoke(
        "notify",
        () => ctx.ui.notify("Cosmic UI failed to start.", "warning"),
        undefined,
      );
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal) =>
    slot.run(effect, signal);
  const runFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const result = run(effect, abort?.signal);
    return abort ? result.finally(abort.release) : result;
  };
  const forkFrom = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      CosmicUiService | FooterRegistryService | FooterProtocolHost | WorkingTimerService
    >,
    ctx: ExtensionContext,
  ) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const guarded = abort ? effect.pipe(Effect.ensuring(Effect.sync(abort.release))) : effect;
    const fiber = slot.fork(guarded, abort?.signal);
    if (!fiber) abort?.release();
    return fiber;
  };

  footerInstallation = createFooterInstallation({
    pi,
    callbacks,
    bridge,
    projection,
    config,
    currentContext: () => (currentContext ? MutableRef.get(currentContext) : undefined),
    clearRenderRequest: (expected) => {
      callbacks.invoke(
        "footer-remove",
        () =>
          slot.fork(
            FooterRegistryService.use((registry) => registry.setRenderRequest(undefined, expected)),
          ),
        undefined,
      );
    },
    installRenderRequest: (request, isCurrent, ctx) => {
      forkFrom(
        FooterRegistryService.use((registry) =>
          Effect.suspend(() => (isCurrent() ? registry.setRenderRequest(request) : Effect.void)),
        ),
        ctx,
      );
    },
    refreshAfterBranchChange: (ctx) => {
      forkFrom(
        CosmicUiService.use((service) =>
          service.invalidateProbes.pipe(Effect.andThen(service.refreshAll(true))),
        ),
        ctx,
      );
    },
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
        if (query) callbacks.invoke("host-query", query.respond, undefined);
      }),
      pi.events.on(COSMIC_UI_FOOTER_UPSERT, (data) => {
        const event = callbacks.invoke(
          "protocol-upsert",
          () => normalizeCosmicFooterUpsertEvent(data),
          undefined,
        );
        if (event) protocolBuffer.offer(protocolUpsert(event));
      }),
      pi.events.on(COSMIC_UI_FOOTER_REMOVE, (data) => {
        const event = callbacks.invoke(
          "protocol-remove",
          () => normalizeCosmicFooterRemoveEvent(data),
          undefined,
        );
        if (event) protocolBuffer.offer(protocolRemove(event));
      }),
      pi.events.on(COSMIC_UI_FOOTER_INVALIDATE, (data) => {
        const event = callbacks.invoke(
          "protocol-invalidate",
          () => normalizeCosmicFooterInvalidateEvent(data),
          undefined,
        );
        if (event) protocolBuffer.offer(protocolInvalidate(event));
      }),
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
    run,
    callbacks,
  });

  pi.on("session_start", (_event, ctx) => {
    const shutdownFailedStart = () =>
      slot.shutdown().then(() => {
        currentContext = undefined;
        resetTotals();
        resetProjection(projection);
      });
    const host = sessionHostFrom(ctx);
    if (host._tag === "Failure") return shutdownFailedStart();
    if (host.aborted) {
      host.releaseSignal();
      return shutdownFailedStart();
    }
    const projectTrusted = isProjectTrusted(ctx);
    ensureSubscriptions();
    footerInstallation.uninstall();
    resetTotals();
    const initialTotals = totalsFromSession(ctx);
    resetProjection(projection, initialTotals);
    const context = MutableRef.make(ctx);
    currentContext = context;
    return slot
      .start(
        {
          ctx,
          context,
          cwd: host.cwd,
          signal: host.signal,
          releaseSignal: host.releaseSignal,
          initialTotals,
          projectTrusted,
        },
        host.signal,
      )
      .then(
        (token) => {
          if (token === undefined) host.releaseSignal();
        },
        () => {
          host.releaseSignal();
          callbacks.invoke(
            "notify",
            () => ctx.ui.notify("Cosmic UI failed to start.", "warning"),
            undefined,
          );
        },
      );
  });

  pi.on("turn_end", (event, ctx) => {
    updateContext(ctx);
    const read = callbacks.invoke<
      | { readonly _tag: "Assistant"; readonly totals: FooterTotals }
      | { readonly _tag: "Rescan" }
      | { readonly _tag: "Failure" }
    >(
      "host-query",
      () => {
        const message = event.message;
        if (!message || message.role !== "assistant") return { _tag: "Rescan" };
        const totals = { ...lastCompleteTotals };
        const usage = message.usage;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        totals.cost += usage.cost.total;
        return { _tag: "Assistant", totals };
      },
      { _tag: "Failure" },
    );
    const totals =
      read._tag === "Assistant"
        ? rememberTotals(read.totals)
        : read._tag === "Rescan"
          ? totalsFromSession(ctx)
          : lastCompleteTotals;
    footerInstallation.invalidateContextUsage();
    requestRender();
    return runFrom(
      CosmicUiService.use((service) =>
        service.setTotals(totals).pipe(Effect.andThen(service.refreshGit())),
      ),
      ctx,
    ).catch(() => undefined);
  });
  const refreshTotals = (ctx: ExtensionContext) => {
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
    return runFrom(
      CosmicUiService.use((service) => service.setTotals(totalsFromSession(ctx))),
      ctx,
    ).catch(() => undefined);
  };
  pi.on("session_compact", (_event, ctx) => refreshTotals(ctx));
  pi.on("session_tree", (_event, ctx) => refreshTotals(ctx));
  const invalidateContextUsage = (_event: unknown, ctx: ExtensionContext) => {
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
  };
  pi.on("model_select", invalidateContextUsage);
  pi.on("tool_execution_end", (event, ctx) => {
    updateContext(ctx);
    if (!["bash", "edit", "write"].includes(event.toolName)) return;
    return runFrom(
      CosmicUiService.use((service) => service.refreshGit(true)),
      ctx,
    ).catch(() => undefined);
  });
  const renderUpdatedContext = (_event: unknown, ctx: ExtensionContext) => {
    updateContext(ctx);
    requestRender();
  };
  pi.on("thinking_level_select", renderUpdatedContext);
  pi.on("session_info_changed", renderUpdatedContext);
  pi.on("agent_start", (event, ctx) => {
    invalidateContextUsage(event, ctx);
    forkFrom(
      WorkingTimerService.use((timer) => timer.start),
      ctx,
    );
  });
  pi.on("agent_end", (_event, ctx) => {
    updateContext(ctx);
    forkFrom(
      WorkingTimerService.use((timer) => timer.stop),
      ctx,
    );
  });
  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", (event, ctx) => {
    invalidateContextUsage(event, ctx);
    const update = event.assistantMessageEvent;
    if (!update || (update.type !== "text_delta" && update.type !== "thinking_delta")) return;
    forkFrom(
      WorkingTimerService.use((timer) => timer.recordOutputCharacters(update.delta.length)),
      ctx,
    );
  });
  pi.on("message_end", invalidateContextUsage);
  pi.on("session_shutdown", () => {
    disposeSubscriptions();
    footerInstallation.uninstall();
    return slot.shutdown().then(() => {
      currentContext = undefined;
      resetTotals();
      protocolBuffer.reset();
      resetProjection(projection);
    });
  });
}
