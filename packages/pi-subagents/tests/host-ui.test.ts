import type {
  ExtensionContext,
  ExtensionWidgetOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import type { SubagentProjection, SubagentRunView } from "../src/run/model.ts";
import { extensionContextFixture } from "./fixtures/pi-host.ts";
import { view } from "./tools/fixtures/tool-harness.ts";

// SAFETY: This fixture implements the Theme methods consumed by the widget renderer.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const projection = (runs: ReadonlyArray<SubagentRunView>): SubagentProjection => ({
  revision: 1,
  root: { id: "root", depth: 0, directChildCount: runs.length, descendantCount: runs.length },
  runs,
});

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

const tuiFixture = <Fixture extends object>(fixture: Fixture): Fixture & TUI => {
  // SAFETY: Each test invokes only the TUI members explicitly implemented by its fixture.
  return fixture as Fixture & TUI;
};

const tui = (requestRender = vi.fn()): TUI => tuiFixture({ requestRender });

const context = (
  setWidget: (
    key: string,
    content: WidgetFactory | string[] | undefined,
    options?: ExtensionWidgetOptions,
  ) => void,
  setStatus = vi.fn(),
): ExtensionContext =>
  extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    ui: { setWidget, setStatus },
  });

const captureFactory = () => {
  let factory: WidgetFactory | undefined;
  const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
    if (content !== undefined && !Array.isArray(content)) factory = content;
  });
  return { getFactory: () => factory, setWidget };
};

describe("subagent activity widget host", () => {
  it("rerenders published projections and releases widget and ticker ownership on clear", () => {
    const { getFactory, setWidget } = captureFactory();
    const setStatus = vi.fn();
    const stopTicker = vi.fn();
    const startTicker = vi.fn(() => stopTicker);
    const bridge = makeSubagentProjectionBridge(undefined, { startTicker, getNow: () => 2_000 });
    bridge.publish(projection([view({ id: "parent" })]));
    bridge.setContext(context(setWidget, setStatus));

    const requestRender = vi.fn();
    const component = getFactory()?.(tui(requestRender), theme);
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    expect(component?.render(100).length).toBeGreaterThan(0);
    expect(startTicker).toHaveBeenCalledOnce();

    bridge.publish(
      projection([view({ id: "parent" }), view({ id: "child", parentRunId: "parent", depth: 2 })]),
    );
    expect(requestRender).toHaveBeenCalled();

    bridge.clear();
    expect(stopTicker).toHaveBeenCalledOnce();
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(component?.render(100)).toEqual([]);
    expect(setWidget.mock.calls.some(([, content]) => content === undefined)).toBe(true);
    expect(setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it("replaces and stops ticker resources as projected run states change", () => {
    const { getFactory, setWidget } = captureFactory();
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const startTicker = vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const bridge = makeSubagentProjectionBridge(undefined, { startTicker });
    bridge.publish(projection([view({ id: "run", state: "waiting_for_parent" })]));
    bridge.setContext(context(setWidget));
    getFactory()?.(tui(), theme);

    bridge.publish(projection([view({ id: "run", state: "running" })]));
    expect(stops[0]).toHaveBeenCalledOnce();

    bridge.publish(projection([view({ id: "run", state: "paused" })]));
    expect(stops[1]).toHaveBeenCalledOnce();

    bridge.publish(projection([view({ id: "run", state: "completed" })]));
    expect(stops[2]).toHaveBeenCalledOnce();
    expect(startTicker).toHaveBeenCalledTimes(3);
    bridge.clear();
  });

  it("restores fallback ownership when the host disposes the widget", () => {
    const { getFactory, setWidget } = captureFactory();
    const setStatus = vi.fn();
    const stopTicker = vi.fn();
    const bridge = makeSubagentProjectionBridge(undefined, { startTicker: () => stopTicker });
    bridge.publish(projection([view({ id: "running" })]));
    const ctx = context(setWidget, setStatus);
    bridge.setContext(ctx);
    const component = getFactory()?.(tui(), theme);

    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    component?.dispose?.();
    expect(stopTicker).toHaveBeenCalledOnce();
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(setStatus.mock.calls.at(-1)?.[1]).toEqual(expect.stringMatching(/\S/));

    bridge.setContext(ctx);
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    bridge.clear();
  });

  it("holds await presentation for the exact lease lifetime", () => {
    const { getFactory, setWidget } = captureFactory();
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: () => () => undefined,
      getNow: () => 2_000,
    });
    const target = view({ id: "target" });
    const other = view({ id: "other" });
    bridge.publish(projection([target, other]));
    bridge.setContext(context(setWidget));
    const component = getFactory()?.(tui(), theme);
    const baseline = component?.render(100);

    const release = bridge.bindToolPresentation().beginAwait([target.id], "all_finished");
    const awaiting = component?.render(100);
    expect(awaiting).not.toEqual(baseline);

    release();
    expect(component?.render(100)).toEqual(baseline);
    bridge.clear();
  });

  it("rejects stale presentation leases after context replacement", () => {
    const first = captureFactory();
    const second = captureFactory();
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: () => () => undefined,
      getNow: () => 2_000,
    });
    const target = view({ id: "target" });

    bridge.publish(projection([target]));
    bridge.setContext(context(first.setWidget));
    const stalePresentation = bridge.bindToolPresentation();
    const staleRelease = stalePresentation.beginAwait([target.id], "all_finished");

    bridge.clear();
    bridge.publish(projection([target]));
    bridge.setContext(context(second.setWidget));
    const component = second.getFactory()?.(tui(), theme);
    const currentPresentation = bridge.bindToolPresentation();
    const currentRelease = currentPresentation.beginAwait([target.id], "all_finished");
    const current = component?.render(100);

    stalePresentation.beginStart(3)();
    staleRelease();
    expect(stalePresentation.isLiveHierarchyAvailable()).toBe(false);
    expect(component?.render(100)).toEqual(current);

    currentRelease();
    expect(component?.render(100)).not.toEqual(current);
    expect(first.setWidget.mock.calls.some(([, content]) => content === undefined)).toBe(true);
    bridge.clear();
  });

  it("falls back when widget installation throws", () => {
    const setStatus = vi.fn();
    const bridge = makeSubagentProjectionBridge();
    bridge.publish(projection([view({ id: "running" })]));
    bridge.setContext(
      context(() => {
        throw new Error("stale widget host");
      }, setStatus),
    );

    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(setStatus.mock.calls.at(-1)?.[1]).toEqual(expect.stringMatching(/\S/));
    expect(() => bridge.clear()).not.toThrow();
  });

  it("uses status fallback in RPC mode without installing a component widget", () => {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const bridge = makeSubagentProjectionBridge();
    const rpc = extensionContextFixture({
      cwd: "/project",
      mode: "rpc" as const,
      hasUI: true,
      ui: { setWidget, setStatus },
    });

    bridge.publish(projection([view({ id: "running" })]));
    bridge.setContext(rpc);
    expect(setWidget).not.toHaveBeenCalled();
    expect(setStatus.mock.calls.at(-1)?.[1]).toEqual(expect.stringMatching(/\S/));
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);

    bridge.clear();
    expect(setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
  });
});
