import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { invokeHostCallback, notifyListeners, synchronousNow } from "pi-cosmic-core";
import type { SubagentProjection } from "../run/model.ts";
import {
  EMPTY_ACTIVITY_PRESENTATION,
  hasSubagentActivityPanelContent,
  projectSubagentActivityPanel,
  renderProjectedSubagentActivityPanel,
  subagentActivityPanelCadence,
  type SubagentActivityAwaitMode,
  type SubagentActivityPanelProjection,
  type SubagentActivityPresentationSnapshot,
} from "../ui/activity-panel.ts";
import {
  makeAdaptiveHostRefreshTicker,
  type AdaptiveHostRefreshTicker,
} from "./host-refresh-ticker.ts";

const WIDGET_KEY = "pi-subagents.activity";

type PresentationLease =
  | { readonly action: "start"; readonly requestedCount: number }
  | {
      readonly action: "await";
      readonly runIds: ReadonlyArray<string>;
      readonly until: SubagentActivityAwaitMode;
    };

export interface SubagentToolPresentation {
  readonly beginStart: (requestedCount: number) => () => void;
  readonly beginAwait: (
    runIds: ReadonlyArray<string>,
    until: SubagentActivityAwaitMode,
  ) => () => void;
  readonly isLiveHierarchyAvailable: () => boolean;
}

export interface SubagentActivityPresentationController {
  readonly get: () => SubagentActivityPresentationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly bindToolPresentation: () => SubagentToolPresentation;
  readonly isPanelAvailable: () => boolean;
  readonly setPanelAvailable: (available: boolean) => void;
  readonly clear: () => void;
}

export const makeSubagentActivityPresentation = (): SubagentActivityPresentationController => {
  let generation = 0;
  let panelAvailable = false;
  let nextLeaseId = 0;
  let snapshot = EMPTY_ACTIVITY_PRESENTATION;
  const leases = new Map<number, PresentationLease>();
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = Object.freeze({
      starts: Object.freeze(
        [...leases.values()].flatMap((lease) =>
          lease.action === "start" ? [Object.freeze({ requestedCount: lease.requestedCount })] : [],
        ),
      ),
      awaits: Object.freeze(
        [...leases.values()].flatMap((lease) =>
          lease.action === "await"
            ? [Object.freeze({ runIds: Object.freeze([...lease.runIds]), until: lease.until })]
            : [],
        ),
      ),
    });
    notifyListeners(listeners);
  };
  const acquire = (lease: PresentationLease): (() => void) => {
    const id = ++nextLeaseId;
    leases.set(id, lease);
    publish();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!leases.delete(id)) return;
      publish();
    };
  };

  return {
    get: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bindToolPresentation: () => {
      const ownerGeneration = generation;
      return {
        beginStart: (requestedCount) =>
          ownerGeneration === generation
            ? acquire({
                action: "start",
                requestedCount: Number.isFinite(requestedCount)
                  ? Math.max(0, Math.floor(requestedCount))
                  : 0,
              })
            : () => undefined,
        beginAwait: (runIds, until) =>
          ownerGeneration === generation
            ? acquire({ action: "await", runIds: [...new Set(runIds)], until })
            : () => undefined,
        isLiveHierarchyAvailable: () => ownerGeneration === generation && panelAvailable,
      };
    },
    isPanelAvailable: () => panelAvailable,
    setPanelAvailable: (available) => {
      if (panelAvailable === available) return;
      panelAvailable = available;
      notifyListeners(listeners);
    },
    clear: () => {
      generation += 1;
      const changed = panelAvailable || leases.size > 0;
      panelAvailable = false;
      leases.clear();
      if (changed) publish();
    },
  };
};

interface ActivityWidgetComponentOptions extends Omit<SubagentActivityWidgetHostOptions, "getNow"> {
  readonly theme: Theme;
  readonly tui: TUI;
  readonly getNow: () => number;
  readonly onDispose: () => void;
}

class SubagentActivityWidgetComponent implements Component {
  private readonly options: ActivityWidgetComponentOptions;
  private readonly unsubscribeProjection: () => void;
  private readonly unsubscribePresentation: () => void;
  private refreshTicker: AdaptiveHostRefreshTicker | undefined;
  private panelCache:
    | {
        readonly projection: SubagentProjection;
        readonly presentation: SubagentActivityPresentationSnapshot;
        readonly panel: SubagentActivityPanelProjection;
      }
    | undefined;
  private renderCache:
    | {
        readonly panel: SubagentActivityPanelProjection;
        readonly width: number;
        readonly lines: string[];
      }
    | undefined;
  private disposed = false;

  constructor(options: ActivityWidgetComponentOptions) {
    this.options = options;
    const refresh = () => {
      if (this.disposed) return;
      this.panelCache = undefined;
      this.renderCache = undefined;
      this.refreshTicker?.sync();
      invokeHostCallback(() => this.options.tui.requestRender(), undefined);
    };
    this.unsubscribeProjection = options.subscribeProjection(refresh);
    this.unsubscribePresentation = options.presentation.subscribe(refresh);
    this.refreshTicker = makeAdaptiveHostRefreshTicker({
      getCadence: () => subagentActivityPanelCadence(this.getPanel()),
      startTicker: options.startTicker,
      requestRender: () => {
        this.renderCache = undefined;
        options.tui.requestRender();
      },
    });
  }

  private getPanel(): SubagentActivityPanelProjection {
    const projection = this.options.getProjection();
    const presentation = this.options.presentation.get();
    if (this.panelCache?.projection === projection && this.panelCache.presentation === presentation)
      return this.panelCache.panel;
    const panel = projectSubagentActivityPanel(projection, presentation);
    this.panelCache = { projection, presentation, panel };
    return panel;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const safeWidth = Math.max(0, Math.floor(width));
    const panel = this.getPanel();
    if (this.renderCache?.panel === panel && this.renderCache.width === safeWidth)
      return this.renderCache.lines;
    const lines = renderProjectedSubagentActivityPanel(
      panel,
      safeWidth,
      this.options.theme,
      this.options.getNow(),
    );
    this.renderCache = { panel, width: safeWidth, lines };
    return lines;
  }

  invalidate(): void {
    this.renderCache = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeProjection();
    this.unsubscribePresentation();
    this.refreshTicker?.dispose();
    this.refreshTicker = undefined;
    this.panelCache = undefined;
    this.renderCache = undefined;
    invokeHostCallback(() => this.options.onDispose(), undefined);
  }
}

const emptyActivityWidget = (): Component => ({ render: () => [], invalidate: () => undefined });

export interface SubagentActivityWidgetHost {
  readonly setContext: (ctx: ExtensionContext | undefined) => void;
  readonly clear: () => void;
}

export interface SubagentActivityWidgetHostOptions {
  readonly getProjection: () => SubagentProjection;
  readonly subscribeProjection: (listener: () => void) => () => void;
  readonly presentation: SubagentActivityPresentationController;
  readonly startTicker: (intervalMs: number, tick: () => void) => () => void;
  readonly getNow?: (() => number) | undefined;
}

export const makeSubagentActivityWidgetHost = (
  options: SubagentActivityWidgetHostOptions,
): SubagentActivityWidgetHost => {
  let context: ExtensionContext | undefined;
  let component: SubagentActivityWidgetComponent | undefined;
  let generation = 0;
  const getNow = options.getNow ?? synchronousNow;

  const disposeComponent = () => {
    component?.dispose();
    component = undefined;
  };
  const clearCurrent = () => {
    generation += 1;
    disposeComponent();
    options.presentation.setPanelAvailable(false);
    const previous = context;
    context = undefined;
    if (!previous) return;
    invokeHostCallback(
      () => previous.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" }),
      undefined,
    );
  };

  return {
    setContext: (next) => {
      if (context === next && options.presentation.isPanelAvailable()) return;
      clearCurrent();
      if (!next || !invokeHostCallback(() => next.hasUI && next.mode === "tui", false)) return;
      context = next;
      const ownerGeneration = generation;
      let factoryFailed = false;
      try {
        next.ui.setWidget(
          WIDGET_KEY,
          (tui, theme) => {
            if (ownerGeneration !== generation || context !== next) return emptyActivityWidget();
            disposeComponent();
            try {
              const created = new SubagentActivityWidgetComponent({
                ...options,
                theme,
                tui,
                getNow,
                onDispose: () => {
                  if (ownerGeneration === generation && context === next)
                    options.presentation.setPanelAvailable(false);
                },
              });
              component = created;
              return created;
            } catch {
              factoryFailed = true;
              options.presentation.setPanelAvailable(false);
              return emptyActivityWidget();
            }
          },
          { placement: "aboveEditor" },
        );
        options.presentation.setPanelAvailable(!factoryFailed);
      } catch {
        context = undefined;
        disposeComponent();
        options.presentation.setPanelAvailable(false);
      }
    },
    clear: clearCurrent,
  };
};

export const shouldSuppressSubagentFooter = (
  projection: SubagentProjection,
  presentation: SubagentActivityPresentationController,
): boolean =>
  presentation.isPanelAvailable() &&
  hasSubagentActivityPanelContent(projection, presentation.get());
