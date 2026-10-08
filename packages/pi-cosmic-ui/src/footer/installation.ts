import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { invokeHostCallback } from "pi-cosmic-core";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { createFooterComponent } from "./component.ts";
import type { FooterRegistry } from "./registry.ts";
import type { CosmicUiProjection } from "../protocol/service.ts";

interface FooterInstallationOptions {
  readonly pi: ExtensionAPI;
  readonly registry: Pick<FooterRegistry, "snapshot">;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly config: () => ResolvedCosmicUiConfig;
  readonly currentContext: () => ExtensionContext | undefined;
  readonly refreshAfterBranchChange: (ctx: ExtensionContext) => void;
  /** Runs whenever the installed footer may have changed; the host deduplicates its broadcast. */
  readonly onActiveChange: () => void;
}

type FooterInstance = ReturnType<typeof createFooterComponent> & { readonly dispose: () => void };

const inertFooter = (): FooterInstance => ({
  render: () => [],
  invalidate: () => undefined,
  invalidateContextUsage: () => undefined,
  dispose: () => undefined,
});

/** One setFooter call: pending while Pi installs it, then active once installation succeeds. */
interface FooterAttempt {
  instance: object | undefined;
  renderRequest: (() => void) | undefined;
  component: ReturnType<typeof createFooterComponent> | undefined;
  readonly disposers: Set<() => void>;
}

const disposeAttempt = (attempt: FooterAttempt | undefined) => {
  for (const dispose of attempt?.disposers ?? []) dispose();
};

/**
 * Owns the synchronous Pi footer installation attempts, exact-once disposal state, and the render
 * request: only the newest instance of the active attempt receives render requests.
 */
export const createFooterInstallation = (options: FooterInstallationOptions) => {
  const { pi, registry, projection, config } = options;
  let installedContext: ExtensionContext | undefined;
  let pending: FooterAttempt | undefined;
  let active: FooterAttempt | undefined;

  const requestRender = () => {
    const request = active?.renderRequest;
    if (request) invokeHostCallback(request, undefined);
  };

  const uninstall = () => {
    const ctx = installedContext;
    if (!ctx) return;
    const attempt = active;
    const removed = invokeHostCallback(() => {
      ctx.ui.setFooter(undefined);
      return true;
    }, false);
    if (!removed || active !== attempt) return;
    disposeAttempt(attempt);
    if (active !== attempt) return;
    active = undefined;
    if (installedContext === ctx) installedContext = undefined;
    pending = undefined;
    options.onActiveChange();
  };

  const update = (fallback: ExtensionContext) => {
    const currentContext = options.currentContext();
    const ctx = currentContext ?? fallback;
    const state = MutableRef.get(projection);
    const current = state.config;
    if (!current || !invokeHostCallback(() => ctx.mode === "tui", false)) return;
    if (installedContext && installedContext !== ctx) uninstall();
    if (!current.footer.enabled) {
      uninstall();
      return;
    }
    if (installedContext) {
      requestRender();
      return;
    }
    const attempt: FooterAttempt = {
      instance: undefined,
      renderRequest: undefined,
      component: undefined,
      disposers: new Set(),
    };
    pending = attempt;
    const ownsAttempt = () => pending === attempt || active === attempt;
    const installed = invokeHostCallback(() => {
      ctx.ui.setFooter((tui, theme, footerData) => {
        if (!ownsAttempt()) return inertFooter();
        return invokeHostCallback<FooterInstance>(() => {
          const instance = Object.freeze({});
          const component = createFooterComponent({
            pi,
            ctx: () => options.currentContext() ?? ctx,
            footerData,
            theme,
            registry,
            config,
            projection: () => MutableRef.get(projection),
          });
          const isCurrentInstance = () => ownsAttempt() && attempt.instance === instance;
          attempt.instance = instance;
          attempt.renderRequest = () => tui.requestRender();
          attempt.component = component;
          const onBranchChange = () => {
            if (!isCurrentInstance()) return;
            invokeHostCallback(() => {
              tui.requestRender();
              options.refreshAfterBranchChange(options.currentContext() ?? ctx);
            }, undefined);
          };
          const unsubscribeBranch = invokeHostCallback<() => void>(
            () => footerData.onBranchChange(onBranchChange),
            () => undefined,
          );
          let disposed = false;
          const dispose = () => {
            if (disposed) return;
            disposed = true;
            attempt.disposers.delete(dispose);
            const currentInstance = isCurrentInstance();
            invokeHostCallback(unsubscribeBranch, undefined);
            if (!currentInstance) return;
            if (active === attempt) {
              active = undefined;
              installedContext = undefined;
              options.onActiveChange();
            } else if (pending === attempt) {
              // Promotion must not revive this disposed instance or its render request.
              attempt.instance = undefined;
              attempt.renderRequest = undefined;
              if (attempt.component === component) attempt.component = undefined;
            } else return;
            disposeAttempt(attempt);
          };
          attempt.disposers.add(dispose);
          return { ...component, dispose };
        }, inertFooter());
      });
      return true;
    }, false);
    if (installed && pending === attempt) {
      pending = undefined;
      active = attempt;
      installedContext = ctx;
      options.onActiveChange();
    } else {
      if (pending === attempt) pending = undefined;
      // The attempt is now neither pending nor active, so its disposers only unsubscribe.
      disposeAttempt(attempt);
    }
  };

  return {
    update,
    uninstall,
    requestRender,
    isActive: () => installedContext !== undefined,
    invalidateContextUsage: () => active?.component?.invalidateContextUsage(),
  };
};
