import type {
  ExtensionContext,
  ExtensionWidgetOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { subagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { extensionContextFixture, plainTheme, tuiFixture } from "pi-cosmic-core/testing";
import { RECENT_MESSAGE_WINDOW_MS } from "../src/ui/activity-panel.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";

type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };

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

const quietBridge = () =>
  subagentProjectionBridge(undefined, {
    startTicker: () => () => undefined,
    getNow: () => 2_000,
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
    const bridge = subagentProjectionBridge(undefined, { startTicker, getNow: () => 2_000 });
    bridge.publish(projectionOf([view({ id: "parent" })]));
    bridge.setContext(context(setWidget, setStatus));

    const requestRender = vi.fn();
    const component = getFactory()?.(tui(requestRender), plainTheme);
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    expect(component?.render(100).length).toBeGreaterThan(0);
    expect(startTicker).toHaveBeenCalledOnce();

    bridge.publish(
      projectionOf([
        view({ id: "parent" }),
        view({ id: "child", parentRunId: "parent", depth: 2 }),
      ]),
    );
    expect(requestRender).toHaveBeenCalled();

    bridge.clear();
    expect(stopTicker).toHaveBeenCalledOnce();
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(component?.render(100)).toEqual([]);
    expect(setWidget.mock.calls.some(([, content]) => content === undefined)).toBe(true);
    expect(setStatus.mock.calls.at(-1)?.[1]).toBeUndefined();
  });
  it("restores fallback ownership when the host disposes the widget", () => {
    const { getFactory, setWidget } = captureFactory();
    const setStatus = vi.fn();
    const stopTicker = vi.fn();
    const bridge = subagentProjectionBridge(undefined, { startTicker: () => stopTicker });
    bridge.publish(projectionOf([view({ id: "running" })]));
    const ctx = context(setWidget, setStatus);
    bridge.setContext(ctx);
    const component = getFactory()?.(tui(), plainTheme);

    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    component?.dispose?.();
    expect(stopTicker).toHaveBeenCalledOnce();
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(setStatus.mock.calls.at(-1)?.[1]).toEqual(expect.stringMatching(/\S/));

    bridge.setContext(ctx);
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    bridge.clear();
  });
  it("rejects stale presentation leases after context replacement", () => {
    const first = captureFactory();
    const second = captureFactory();
    const bridge = quietBridge();
    const target = view({ id: "target" });

    bridge.publish(projectionOf([target]));
    bridge.setContext(context(first.setWidget));
    const stalePresentation = bridge.bindToolPresentation();
    const staleRelease = stalePresentation.beginAwait([target.id], "all_finished");

    bridge.clear();
    bridge.publish(projectionOf([target]));
    bridge.setContext(context(second.setWidget));
    const component = second.getFactory()?.(tui(), plainTheme);
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

  it("drops an expired message on refresh ticks alone and stops ticking when cleared", () => {
    const { getFactory, setWidget } = captureFactory();
    let now = 10_000;
    const ticks: Array<() => void> = [];
    const stopTicker = vi.fn();
    const bridge = subagentProjectionBridge(undefined, {
      startTicker: (_intervalMs, tick) => {
        ticks.push(tick);
        return stopTicker;
      },
      getNow: () => now,
    });
    bridge.publish(
      projectionOf([
        view({
          id: "talker",
          state: "waiting_for_parent",
          messageCount: 1,
          sessionEvents: [
            {
              type: "notice",
              kind: "message",
              direction: "out",
              peer: "main",
              text: "ping from talker",
              createdAt: now,
            },
          ],
        }),
      ]),
    );
    bridge.setContext(context(setWidget));
    const component = getFactory()?.(tui(), plainTheme);
    const shows = () => component?.render(120).some((line) => line.includes("ping from talker"));

    expect(shows()).toBe(true);
    now += RECENT_MESSAGE_WINDOW_MS + 1_000;
    for (const tick of ticks) tick();
    expect(shows()).toBe(false);

    bridge.clear();
    expect(stopTicker).toHaveBeenCalled();
  });

  it("falls back when widget installation throws", () => {
    const setStatus = vi.fn();
    const bridge = subagentProjectionBridge();
    bridge.publish(projectionOf([view({ id: "running" })]));
    bridge.setContext(
      context(() => {
        throw new Error("stale widget host");
      }, setStatus),
    );

    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(setStatus.mock.calls.at(-1)?.[1]).toEqual(expect.stringMatching(/\S/));
    expect(() => bridge.clear()).not.toThrow();
  });
});
