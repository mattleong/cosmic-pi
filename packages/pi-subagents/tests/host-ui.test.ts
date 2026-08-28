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

describe("subagent activity widget host", () => {
  it("installs above the editor, renders live hierarchy, and suppresses duplicate footer status", () => {
    let factory: WidgetFactory | undefined;
    const setWidget = vi.fn(
      (
        _key: string,
        content: WidgetFactory | string[] | undefined,
        _options?: ExtensionWidgetOptions,
      ) => {
        if (content !== undefined && !Array.isArray(content)) factory = content;
      },
    );
    const setStatus = vi.fn();
    const stopTicker = vi.fn();
    const startTicker = vi.fn(() => stopTicker);
    const bridge = makeSubagentProjectionBridge(undefined, { startTicker, getNow: () => 2_000 });
    bridge.publish(projection([view({ id: "parent", name: "Parent" })]));
    bridge.setContext(context(setWidget, setStatus));

    expect(setWidget).toHaveBeenCalledWith("pi-subagents.activity", expect.any(Function), {
      placement: "aboveEditor",
    });
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", undefined);

    const requestRender = vi.fn();
    const component = factory?.(tui(requestRender), theme);
    expect(component?.render(100).join("\n")).toContain("Parent");
    expect(startTicker).toHaveBeenCalledWith(160, expect.any(Function));

    bridge.publish(
      projection([
        view({ id: "parent", name: "Parent" }),
        view({ id: "child", name: "Child", parentRunId: "parent", depth: 2 }),
      ]),
    );
    expect(requestRender).toHaveBeenCalled();
    expect(component?.render(100).join("\n")).toContain("Child");

    bridge.clear();
    expect(stopTicker).toHaveBeenCalled();
    expect(setWidget).toHaveBeenLastCalledWith("pi-subagents.activity", undefined, {
      placement: "aboveEditor",
    });
    expect(component?.render(100)).toEqual([]);
  });

  it("keeps start-only presentation static without spending an animation ticker", () => {
    let factory: WidgetFactory | undefined;
    const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) factory = content;
    });
    const startTicker = vi.fn(() => () => undefined);
    const bridge = makeSubagentProjectionBridge(undefined, { startTicker });
    bridge.setContext(context(setWidget));
    const component = factory?.(tui(), theme);

    const release = bridge.bindToolPresentation().beginStart(3);
    expect(component?.render(100)).toEqual([" Subagents · launching 3 · /subagents"]);
    expect(startTicker).not.toHaveBeenCalled();

    release();
    bridge.clear();
  });

  it("replaces widget ticker cadence as projected run states change", () => {
    let factory: WidgetFactory | undefined;
    const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) factory = content;
    });
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const startTicker = vi.fn(() => {
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    });
    const bridge = makeSubagentProjectionBridge(undefined, { startTicker });
    bridge.publish(projection([view({ id: "run", state: "waiting_for_parent" })]));
    bridge.setContext(context(setWidget));
    factory?.(tui(), theme);

    expect(startTicker).toHaveBeenLastCalledWith(1_000, expect.any(Function));
    bridge.publish(projection([view({ id: "run", state: "running" })]));
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(startTicker).toHaveBeenLastCalledWith(160, expect.any(Function));

    bridge.publish(projection([view({ id: "run", state: "paused" })]));
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(startTicker).toHaveBeenLastCalledWith(1_000, expect.any(Function));

    bridge.publish(projection([view({ id: "run", state: "completed" })]));
    expect(stops[2]).toHaveBeenCalledOnce();
    expect(startTicker).toHaveBeenCalledTimes(3);
    bridge.clear();
  });

  it("invalidates cached clock presentation when the host ticker advances", () => {
    let factory: WidgetFactory | undefined;
    let tick: (() => void) | undefined;
    let now = 1_001;
    const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) factory = content;
    });
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: (_intervalMs, next) => {
        tick = next;
        return () => undefined;
      },
      getNow: () => now,
    });
    bridge.publish(projection([view({ id: "run", startedAt: 1 })]));
    bridge.setContext(context(setWidget));
    const component = factory?.(tui(), theme);

    expect(component?.render(120).join("\n")).toContain("1s");
    now = 2_001;
    tick?.();
    expect(component?.render(120).join("\n")).toContain("2s");
    bridge.clear();
  });

  it("restores footer and card fallbacks when the host disposes the widget", () => {
    let factory: WidgetFactory | undefined;
    const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) factory = content;
    });
    const setStatus = vi.fn();
    const stopTicker = vi.fn();
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: () => stopTicker,
    });
    bridge.publish(projection([view({ id: "running" })]));
    const ctx = context(setWidget, setStatus);
    bridge.setContext(ctx);
    const toolPresentation = bridge.bindToolPresentation();
    const component = factory?.(tui(), theme);

    expect(toolPresentation.isLiveHierarchyAvailable()).toBe(true);
    component?.dispose?.();

    expect(stopTicker).toHaveBeenCalledOnce();
    expect(toolPresentation.isLiveHierarchyAvailable()).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", "1 subagent working");

    bridge.setContext(ctx);
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(true);
    expect(setWidget).toHaveBeenLastCalledWith("pi-subagents.activity", expect.any(Function), {
      placement: "aboveEditor",
    });
    bridge.clear();
  });

  it("switches the panel into await mode for the exact execution lifetime", () => {
    let factory: WidgetFactory | undefined;
    const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) factory = content;
    });
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: () => () => undefined,
      getNow: () => 2_000,
    });
    const target = view({ id: "target", name: "Target" });
    const other = view({ id: "other", name: "Other" });
    bridge.publish(projection([target, other]));
    bridge.setContext(context(setWidget));
    const component = factory?.(tui(), theme);

    const toolPresentation = bridge.bindToolPresentation();
    const release = toolPresentation.beginAwait([target.id], "all_finished");
    const awaiting = component?.render(100).join("\n") ?? "";
    expect(awaiting).toContain("Subagents · 0/1 awaited");
    expect(awaiting.split("\n").find((line) => line.includes("Target"))).toContain("◎");
    expect(awaiting.split("\n").find((line) => line.includes("Other"))).not.toContain("◎");

    release();
    expect(component?.render(100).join("\n")).toContain("Subagents · 2 active");
    expect(component?.render(100).join("\n")).not.toContain("0/1");
    bridge.clear();
  });

  it("leaves retained-only ownership in the footer while the panel renders no lines", () => {
    let factory: WidgetFactory | undefined;
    const setWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) factory = content;
    });
    const setStatus = vi.fn();
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: () => () => undefined,
    });
    bridge.setContext(context(setWidget, setStatus));
    const component = factory?.(tui(), theme);

    bridge.publish(
      projection([
        view({ id: "working", state: "running" }),
        view({ id: "retained", state: "reported" }),
      ]),
    );
    expect(component?.render(100)[0]).toContain("1 retained");
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", undefined);

    bridge.publish(projection([view({ id: "retained", state: "reported" })]));
    expect(component?.render(100)).toEqual([]);
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", "1 retained");
    bridge.clear();
  });

  it("clears the old context and rejects stale presentation leases on replacement", () => {
    let secondFactory: WidgetFactory | undefined;
    const firstSetWidget = vi.fn();
    const secondSetWidget = vi.fn((_key: string, content: WidgetFactory | string[] | undefined) => {
      if (content !== undefined && !Array.isArray(content)) secondFactory = content;
    });
    const bridge = makeSubagentProjectionBridge(undefined, {
      startTicker: () => () => undefined,
      getNow: () => 2_000,
    });
    const first = context(firstSetWidget);
    const second = context(secondSetWidget);
    const target = view({ id: "target", name: "Target" });

    bridge.publish(projection([target]));
    bridge.setContext(first);
    const staleToolPresentation = bridge.bindToolPresentation();
    const staleRelease = staleToolPresentation.beginAwait([target.id], "all_finished");
    bridge.clear();
    bridge.publish(projection([target]));
    bridge.setContext(second);
    const component = secondFactory?.(tui(), theme);
    const currentToolPresentation = bridge.bindToolPresentation();
    const currentRelease = currentToolPresentation.beginAwait([target.id], "all_finished");

    staleToolPresentation.beginStart(3)();
    staleRelease();
    expect(staleToolPresentation.isLiveHierarchyAvailable()).toBe(false);
    expect(component?.render(100).join("\n")).toContain("Subagents · 0/1 awaited");
    expect(component?.render(100).join("\n")).not.toContain("Starting 3");
    expect(firstSetWidget).toHaveBeenLastCalledWith("pi-subagents.activity", undefined, {
      placement: "aboveEditor",
    });
    expect(secondSetWidget).toHaveBeenCalledWith("pi-subagents.activity", expect.any(Function), {
      placement: "aboveEditor",
    });
    currentRelease();
    bridge.clear();
  });

  it("falls back to footer and tool rendering when setWidget throws", () => {
    const setStatus = vi.fn();
    const bridge = makeSubagentProjectionBridge();
    bridge.publish(projection([view({ id: "running" })]));
    bridge.setContext(
      context(() => {
        throw new Error("stale widget host");
      }, setStatus),
    );

    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", "1 subagent working");
    expect(() => bridge.clear()).not.toThrow();
  });

  it("publishes compact RPC status without installing a component widget", () => {
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
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", "1 subagent working");
    expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    bridge.clear();
    expect(setStatus).toHaveBeenLastCalledWith("pi-subagents", undefined);
  });
});
