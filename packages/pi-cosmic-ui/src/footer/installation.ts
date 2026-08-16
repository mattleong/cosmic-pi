import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import type { HostCallbackBoundaryContract } from "../boundary/host-callback.ts";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { createFooterComponent } from "./component.ts";
import type { FooterRegistryBridge } from "./registry.ts";
import type { CosmicUiProjection } from "../protocol/service.ts";

interface FooterInstallationOptions {
  readonly pi: ExtensionAPI;
  readonly callbacks: HostCallbackBoundaryContract;
  readonly bridge: FooterRegistryBridge;
  readonly projection: MutableRef.MutableRef<CosmicUiProjection>;
  readonly config: () => ResolvedCosmicUiConfig;
  readonly currentContext: () => ExtensionContext | undefined;
  readonly clearRenderRequest: (expected: () => void) => void;
  readonly installRenderRequest: (
    request: () => void,
    isCurrent: () => boolean,
    ctx: ExtensionContext,
  ) => void;
  readonly refreshAfterBranchChange: (ctx: ExtensionContext) => void;
}

/** Owns the synchronous Pi footer installation generation and exact-once disposal state. */
export const createFooterInstallation = (options: FooterInstallationOptions) => {
  const { pi, callbacks, bridge, projection, config } = options;
  let installedContext: ExtensionContext | undefined;
  let footerComponent: ReturnType<typeof createFooterComponent> | undefined;
  let footerInstallGeneration = 0;
  let pendingFooterGeneration: number | undefined;
  let activeFooterGeneration: number | undefined;
  let activeFooterInstance: object | undefined;
  let activeFooterRenderRequest: (() => void) | undefined;
  let activeFooterDisposeAll: (() => void) | undefined;

  const uninstall = () => {
    const ctx = installedContext;
    if (!ctx) return;
    const generation = activeFooterGeneration;
    const disposeAll = activeFooterDisposeAll;
    const renderRequest = activeFooterRenderRequest;
    const removed = callbacks.invoke(
      "footer-remove",
      () => {
        ctx.ui.setFooter(undefined);
        return true;
      },
      false,
    );
    if (!removed) return;
    if (activeFooterGeneration !== generation) return;
    disposeAll?.();
    if (activeFooterGeneration !== generation) return;
    activeFooterGeneration = undefined;
    activeFooterInstance = undefined;
    activeFooterRenderRequest = undefined;
    activeFooterDisposeAll = undefined;
    if (installedContext === ctx) installedContext = undefined;
    footerComponent = undefined;
    pendingFooterGeneration = undefined;
    if (renderRequest) options.clearRenderRequest(renderRequest);
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
      bridge.requestRenderNow();
      return;
    }
    const generation = ++footerInstallGeneration;
    pendingFooterGeneration = generation;
    type FooterInstance = ReturnType<typeof createFooterComponent> & {
      readonly dispose: () => void;
    };
    const inertFooter = (): FooterInstance => ({
      render: () => [],
      invalidate: () => undefined,
      invalidateContextUsage: () => undefined,
      dispose: () => undefined,
    });
    let stagedComponent: ReturnType<typeof createFooterComponent> | undefined;
    let stagedInstance: object | undefined;
    let stagedRenderRequest: (() => void) | undefined;
    const attemptDisposers = new Set<() => void>();
    const ownsGeneration = () =>
      pendingFooterGeneration === generation || activeFooterGeneration === generation;
    const disposeAll = () => {
      for (const dispose of attemptDisposers) dispose();
    };
    const installed = callbacks.invoke(
      "footer-install",
      () => {
        ctx.ui.setFooter((tui, theme, footerData) => {
          if (!ownsGeneration()) return inertFooter();
          return callbacks.invoke<FooterInstance>(
            "footer-install",
            () => {
              const instance = Object.freeze({});
              const renderRequest = () => tui.requestRender();
              const component = createFooterComponent({
                pi,
                ctx: () => options.currentContext() ?? ctx,
                footerData,
                theme,
                registry: {
                  snapshot: () => bridge.snapshot,
                  invalidate: () => bridge.invalidate(),
                },
                callbacks,
                config,
                totals: () => MutableRef.get(projection).totals,
                gitStatus: () => MutableRef.get(projection).gitStatus,
                pullRequestNumber: () => MutableRef.get(projection).pullRequestNumber,
                homeDirectory: () => MutableRef.get(projection).homeDirectory,
              });
              const isCurrentInstance = () =>
                activeFooterGeneration === generation
                  ? activeFooterInstance === instance
                  : pendingFooterGeneration === generation && stagedInstance === instance;
              if (activeFooterGeneration === generation) {
                activeFooterInstance = instance;
                activeFooterRenderRequest = renderRequest;
                footerComponent = component;
              } else {
                stagedInstance = instance;
                stagedRenderRequest = renderRequest;
                stagedComponent = component;
              }
              options.installRenderRequest(
                renderRequest,
                isCurrentInstance,
                options.currentContext() ?? ctx,
              );
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
                attemptDisposers.delete(dispose);
                const currentInstance = isCurrentInstance();
                callbacks.invoke("branch-unsubscribe", unsubscribeBranch, undefined);
                if (!currentInstance) return;
                options.clearRenderRequest(renderRequest);
                if (activeFooterGeneration === generation) {
                  activeFooterGeneration = undefined;
                  activeFooterInstance = undefined;
                  activeFooterRenderRequest = undefined;
                  activeFooterDisposeAll = undefined;
                  installedContext = undefined;
                  if (footerComponent === component) footerComponent = undefined;
                  disposeAll();
                } else if (pendingFooterGeneration === generation) {
                  stagedInstance = undefined;
                  stagedRenderRequest = undefined;
                  if (stagedComponent === component) stagedComponent = undefined;
                  disposeAll();
                }
              };
              attemptDisposers.add(dispose);
              return { ...component, dispose };
            },
            inertFooter(),
          );
        });
        return true;
      },
      false,
    );
    if (installed && pendingFooterGeneration === generation) {
      pendingFooterGeneration = undefined;
      activeFooterGeneration = generation;
      activeFooterInstance = stagedInstance;
      activeFooterRenderRequest = stagedRenderRequest;
      activeFooterDisposeAll = disposeAll;
      installedContext = ctx;
      if (stagedComponent) footerComponent = stagedComponent;
    } else {
      if (pendingFooterGeneration === generation) pendingFooterGeneration = undefined;
      const failedRenderRequest = stagedRenderRequest;
      disposeAll();
      if (failedRenderRequest) options.clearRenderRequest(failedRenderRequest);
      stagedComponent = undefined;
      stagedInstance = undefined;
      stagedRenderRequest = undefined;
    }
  };

  return {
    update,
    uninstall,
    invalidateContextUsage: () => footerComponent?.invalidateContextUsage(),
  };
};
