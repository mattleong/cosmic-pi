import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import type { HostCallbackBoundaryContract } from "../boundary/host-callback.ts";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { createFooterComponent } from "./component.ts";
import type { FooterRegistry } from "./registry.ts";
import type { CosmicUiProjection } from "../protocol/service.ts";

interface FooterInstallationOptions {
  readonly pi: ExtensionAPI;
  readonly callbacks: HostCallbackBoundaryContract;
  readonly registry: Pick<FooterRegistry, "snapshot">;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly config: () => ResolvedCosmicUiConfig;
  readonly currentContext: () => ExtensionContext | undefined;
  readonly refreshAfterBranchChange: (ctx: ExtensionContext) => void;
  readonly onActiveChange: (active: boolean) => void;
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
  const { pi, callbacks, registry, projection, config } = options;
  let installedContext: ExtensionContext | undefined;
  let pending: FooterAttempt | undefined;
  let active: FooterAttempt | undefined;
  let publishedActive = false;
  const publishActive = (next: boolean) => {
    if (next === publishedActive) return;
    publishedActive = next;
    options.onActiveChange(next);
  };

  const requestRender = () => {
    const request = active?.renderRequest;
    if (request) callbacks.invoke("request-render", request, undefined);
  };

  const uninstall = () => {
    const ctx = installedContext;
    if (!ctx) return;
    const attempt = active;
    const removed = callbacks.invoke(
      "footer-remove",
      () => {
        ctx.ui.setFooter(undefined);
        return true;
      },
      false,
    );
    if (!removed || active !== attempt) return;
    disposeAttempt(attempt);
    if (active !== attempt) return;
    active = undefined;
    if (installedContext === ctx) installedContext = undefined;
    pending = undefined;
    publishActive(false);
  };

  const update = (fallback: ExtensionContext) => {
    const currentContext = options.currentContext();
    const ctx = currentContext ?? fallback;
    const state = MutableRef.get(projection);
    const current = state.config;
    if (!current || !callbacks.invoke("host-query", () => ctx.mode === "tui", false)) return;
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
    const installed = callbacks.invoke(
      "footer-install",
      () => {
        ctx.ui.setFooter((tui, theme, footerData) => {
          if (!ownsAttempt()) return inertFooter();
          return callbacks.invoke<FooterInstance>(
            "footer-install",
            () => {
              const instance = Object.freeze({});
              const component = createFooterComponent({
                pi,
                ctx: () => options.currentContext() ?? ctx,
                footerData,
                theme,
                registry,
                callbacks,
                config,
                projection: () => MutableRef.get(projection),
              });
              const isCurrentInstance = () => ownsAttempt() && attempt.instance === instance;
              attempt.instance = instance;
              attempt.renderRequest = () => tui.requestRender();
              attempt.component = component;
              const onBranchChange = () => {
                if (!isCurrentInstance()) return;
                callbacks.invoke(
                  "request-render",
                  () => {
                    tui.requestRender();
                    options.refreshAfterBranchChange(options.currentContext() ?? ctx);
                  },
                  undefined,
                );
              };
              const unsubscribeBranch = callbacks.invoke<() => void>(
                "host-query",
                () => footerData.onBranchChange(onBranchChange),
                () => undefined,
              );
              let disposed = false;
              const dispose = () => {
                if (disposed) return;
                disposed = true;
                attempt.disposers.delete(dispose);
                const currentInstance = isCurrentInstance();
                callbacks.invoke("branch-unsubscribe", unsubscribeBranch, undefined);
                if (!currentInstance) return;
                if (active === attempt) {
                  active = undefined;
                  installedContext = undefined;
                  publishActive(false);
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
            },
            inertFooter(),
          );
        });
        return true;
      },
      false,
    );
    if (installed && pending === attempt) {
      pending = undefined;
      active = attempt;
      installedContext = ctx;
      publishActive(true);
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
