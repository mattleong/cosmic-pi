import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { ActivityComponent } from "../src/activity/component.ts";
import {
  activityKey,
  registerActivityProvider,
  type ActivityEvents,
} from "../src/activity/protocol.ts";
import {
  ActivityService,
  type ActivityActionRequest,
  type ActivityError,
} from "../src/activity/service.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { makeActivityHost } from "../src/boundary/host-activity.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";
const row = (id: string): ActivityRow => ({
  id,
  key: activityKey("agents", id),
  title: id,
  kind: "agent",
  status: "running",
  revision: "1",
  generation: 1,
  providerId: "agents",
});
const events = (): ActivityEvents => {
  const handlers = new Map<string, Set<Parameters<ActivityEvents["on"]>[1]>>();
  return {
    on(name, handler) {
      const listeners = handlers.get(name) ?? new Set();
      listeners.add(handler);
      handlers.set(name, listeners);
      return () => {
        listeners.delete(handler);
      };
    },
    emit(name, value) {
      for (const handler of handlers.get(name) ?? []) handler(value);
    },
  };
};
describe("activity presentation", () => {
  it("renders metadata-only launches in the header even when history is the only row content", () => {
    const launch = renderActivityWidget([], 80, 8, { starting: 2 });
    expect(launch).toHaveLength(1);
    expect(renderActivityWidget([], 80, 8, { starting: 3 })).toEqual(launch);
    expect(renderActivityWidget([], 80, 8, { starting: 2, now: 100 })).not.toEqual(launch);
    expect(
      renderActivityWidget([{ ...row("old"), status: "done" }], 80, 8, { starting: 2 })[0],
    ).toBe(launch[0]);
    expect(renderActivityWidget([], 80, 8, { starting: 0 })).toEqual([]);
  });
  it("uses real row glyphs without adding launch or await labels", () => {
    const active = row("demo");
    const normal = renderActivityWidget([active], 80, 8, { now: 100 });
    expect(renderActivityWidget([active], 80, 8, { starting: 2, now: 100 })).toEqual(normal);
    expect(renderActivityWidget([active], 80, 8, { now: 200 })).not.toEqual(normal);
  });
  it("marks only explicit await targets while preserving animation and unmarked descendants", () => {
    const active = row("owner");
    const child = { ...row("child"), parent: { providerId: active.providerId, itemId: active.id } };
    const normal = renderActivityWidget([active, child], 80, 8, { now: 100 });
    const targets = [{ ...active, awaited: true }, child];
    const marked = renderActivityWidget(targets, 80, 8, { now: 100 });
    expect(marked[0]).toBe(normal[0]);
    expect(marked[1]).not.toBe(normal[1]);
    expect(marked[1]!.indexOf(active.title)).toBeGreaterThanOrEqual(0);
    expect(marked[1]!.indexOf(active.title)).toBe(normal[1]!.indexOf(active.title));
    expect(marked.slice(2)).toEqual(normal.slice(2));
    expect(renderActivityWidget(targets, 80, 8, { now: 200 })[1]).not.toBe(marked[1]);
    expect(
      renderActivityWidget([{ ...active, awaited: false }, child], 80, 8, { now: 100 }),
    ).toEqual(normal);
  });
  it("keeps the supplied profile visible ahead of long names and branch warnings", () => {
    const owner = { ...row("a very long task name"), profile: "researcher", awaited: true };
    const child: ActivityRow = {
      ...row("question"),
      status: "needs-input",
      parent: { providerId: owner.providerId, itemId: owner.id },
    };
    for (const width of [24, 32, 48]) {
      const lines = renderActivityWidget([owner, child], width, 8, {
        collapsed: new Set([owner.key]),
      });
      expect(lines.join("\n")).toContain(owner.profile);
      const unmarked = renderActivityWidget([{ ...owner, awaited: false }, child], width, 8, {
        collapsed: new Set([owner.key]),
      });
      expect(unmarked.join("\n")).toContain(owner.profile);
      const profileColumn = (output: readonly string[]) => {
        const line = output.find((value) => value.includes(owner.profile))!;
        return visibleWidth(line.slice(0, line.indexOf(owner.profile)));
      };
      expect(profileColumn(lines)).toBe(profileColumn(unmarked));
      for (const line of [...lines, ...unmarked])
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it("accepts only the latest detail refresh even for the same revision", () => {
    const deliveries: Array<(text: string) => void> = [];
    const component = new ActivityComponent({
      snapshot: () => [row("work")],
      theme: { fg: (_color, text) => text },
      height: () => 16,
      close: () => undefined,
      requestRender: () => undefined,
      loadDetail: (_request, deliver) => {
        deliveries.push(deliver);
      },
    });
    component.render(120);
    component.handleInput("\r");
    deliveries[0]!("baseline-log");
    component.handleInput("r");
    component.handleInput("r");
    deliveries[1]!("obsolete-log");
    expect(component.render(120).join("\n")).toContain("baseline-log");
    deliveries[2]!("latest-log");
    deliveries[1]!("obsolete-log");
    const text = component.render(120).join("\n");
    expect(text).toContain("latest-log");
    expect(text).not.toContain("obsolete-log");
  });
  it("keeps viewed log lines steady on refresh and freshness changes", () => {
    let current = row("work");
    const deliveries: Array<(text: string) => void> = [];
    const logs = (count: number) =>
      Array.from({ length: count }, (_, index) => `log-${index}`).join("\n");
    const component = new ActivityComponent({
      snapshot: () => [current],
      theme: { fg: (_color, text) => text },
      height: () => 16,
      close: () => undefined,
      requestRender: () => undefined,
      loadDetail: (_request, deliver) => {
        deliveries.push(deliver);
      },
    });
    const visibleLogs = () =>
      component
        .render(120)
        .join("\n")
        .match(/log-\d+/g);
    component.render(120);
    component.handleInput("\r");
    deliveries[0]!(logs(30));
    const original = visibleLogs();
    expect(original?.length).toBeGreaterThan(0);
    component.handleInput("r");
    component.render(120);
    deliveries[1]!(logs(40));
    // New lines may fill the old trailing blank rows, but must not move viewed log lines.
    expect(visibleLogs()?.slice(0, original?.length)).toEqual(original);
    component.handleInput("k");
    const scrolled = visibleLogs();
    current = { ...current, revision: "2" };
    expect(visibleLogs()).toEqual(scrolled);
    component.handleInput("r");
    deliveries[2]!(logs(45));
    expect(visibleLogs()).toEqual(scrolled);
  });
  it("can reopen an explicitly collapsed branch after it becomes finished history", () => {
    let rows: ActivityRow[] = [
      row("parent"),
      { ...row("child"), parent: { providerId: "agents", itemId: "parent" } },
    ];
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: () => undefined,
      requestRender: () => undefined,
    });
    component.render(80);
    component.handleInput("c");
    rows = rows.map((entry) => ({ ...entry, status: "done" }));
    component.render(80);
    component.handleInput("c");
    component.render(80);
    component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(rows[1]!.key);
  });
  it("bounds typed deep hierarchy and owner paths across narrow layout thresholds", () => {
    const rows = Array.from({ length: 16 }, (_, index) => {
      const entry: ActivityRow = {
        ...row(String(index)),
        title: "长い所有者の名前 ".repeat(8),
        kind: index === 15 ? "question" : index === 14 ? "command" : "agent",
        status: index === 15 ? "needs-input" : "running",
      };
      if (index)
        Object.assign(entry, { parent: { providerId: "agents", itemId: String(index - 1) } });
      return entry;
    });
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text },
      height: () => 20,
      close: () => undefined,
      requestRender: () => undefined,
    });
    for (const width of [1, 21, 22, 29, 30, 47, 48, 59, 60, 100]) {
      for (const line of [...renderActivityWidget(rows, width), ...component.render(width)])
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(rows[15]!.key);
  });
  it("keeps selection identity when live rows reorder and dispatches only explicit actions", () => {
    let rows = [row("a"), { ...row("b"), actions: [{ id: "open", label: "Open" }] }];
    const closed: Array<ActivityActionRequest | undefined> = [];
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: (request) => {
        closed.push(request);
      },
      requestRender: () => undefined,
    });
    component.render(80);
    component.handleInput("j");
    rows = [rows[1]!, rows[0]!];
    component.render(80);
    expect(component.shell.state.selectedId).toBe(row("b").key);
    component.handleInput("1");
    expect(closed[0]).toMatchObject({ key: row("b").key, revision: "1", actionId: "open" });
  });
  it("dispatches the displayed capability rather than a changed action occupying its key", () => {
    let current = { ...row("a"), actions: [{ id: "open", label: "Open" }] };
    const closed: Array<ActivityActionRequest | undefined> = [];
    const component = new ActivityComponent({
      snapshot: () => [current],
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: (request) => {
        closed.push(request);
      },
      requestRender: () => undefined,
    });
    component.render(80);
    current = { ...current, revision: "2", actions: [{ id: "stop", label: "Stop" }] };
    component.handleInput("1");
    expect(closed[0]).toMatchObject({ revision: "1", actionId: "open" });
  });
  it("requires a separate confirmation and retains the displayed destructive scope", () => {
    let current = {
      ...row("a"),
      actions: [
        {
          id: "stop",
          label: "Stop branch",
          confirmation: "Stop this branch and its two descendants?",
        },
      ],
    };
    const closed: Array<ActivityActionRequest | undefined> = [];
    const component = new ActivityComponent({
      snapshot: () => [current],
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: (request) => {
        closed.push(request);
      },
      requestRender: () => undefined,
      matchesKeybinding: (data, id) => data === "accept" && id === "tui.select.confirm",
    });
    component.render(80);
    component.handleInput("1");
    component.handleInput("1");
    expect(closed).toEqual([]);
    current = { ...current, revision: "2" };
    component.handleInput("accept");
    expect(closed[0]).toMatchObject({ revision: "1", actionId: "stop" });
  });
  it("keeps inspected detail across revisions until explicit refresh", () => {
    let current = row("a");
    let loads = 0;
    const component = new ActivityComponent({
      snapshot: () => [current],
      theme: { fg: (_color, text) => text },
      height: () => 20,
      close: () => undefined,
      requestRender: () => undefined,
      loadDetail: (_request, deliver) => {
        loads++;
        deliver(`log-${loads}`);
      },
    });
    component.render(120);
    component.handleInput("\r");
    expect(component.render(120).join("\n")).toContain("log-1");
    current = { ...current, revision: "2" };
    expect(component.render(120).join("\n")).toContain("log-1");
    expect(loads).toBe(1);
    component.handleInput("r");
    expect(component.render(120).join("\n")).toContain("log-2");
  });
  it("makes every advertised action reachable", () => {
    const current = {
      ...row("a"),
      actions: Array.from({ length: 16 }, (_, index) => ({
        id: String(index),
        label: String(index),
      })),
    };
    const closed: Array<ActivityActionRequest | undefined> = [];
    const component = new ActivityComponent({
      snapshot: () => [current],
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: (request) => {
        closed.push(request);
      },
      requestRender: () => undefined,
    });
    component.render(80);
    component.handleInput("a");
    component.render(80);
    component.handleInput("7");
    expect(closed[0]?.actionId).toBe("15");
  });
  it("focuses and collapses branches without losing access to needs-you children", () => {
    const parent = row("parent");
    const child = {
      ...row("question"),
      kind: "question" as const,
      status: "needs-input" as const,
      parent: { providerId: "agents", itemId: "parent" },
    };
    const component = new ActivityComponent({
      snapshot: () => [parent, child, row("other")],
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: () => undefined,
      requestRender: () => undefined,
    });
    component.presentation.collapsed.add(row("other").key);
    component.render(40);
    component.handleInput("c");
    component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(row("other").key);
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(child.key);
    expect(component.presentation.collapsed.has(row("other").key)).toBe(true);
    component.handleInput("f");
    component.render(40);
    expect(component.shell.state.selectedId).toBe(child.key);
  });
  it("bounds persistent rows and every line at narrow and wide terminal sizes", () => {
    const rows = Array.from({ length: 80 }, (_, index) => row(`Long activity ${index} 界界界`));
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text },
      height: () => 12,
      close: () => undefined,
      requestRender: () => undefined,
    });
    for (const width of [0, 1, 2, 8, 30, 70, 120]) {
      const widget = renderActivityWidget(rows, width);
      expect(widget.length).toBeLessThanOrEqual(8);
      for (const line of [...widget, ...component.render(width)])
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it.effect(
    "acknowledges providers only after a live widget factory installs and revokes on teardown",
    () =>
      Effect.gen(function* () {
        const bus = events();
        const pending: Array<Effect.Effect<void, ActivityError>> = [];
        const host = makeActivityHost(extensionApiFixture({ events: bus }), (work) => {
          pending.push(work);
        });
        let service: typeof ActivityService.Service | undefined;
        service = yield* ActivityService.make({
          publish: (rows) => {
            if (service) host.publish(service, rows);
          },
          connect: host.bind,
        });
        let widget: Parameters<ExtensionContext["ui"]["setWidget"]>[1];
        const ctx = extensionContextFixture({
          mode: "tui",
          sessionManager: { getSessionId: () => "session" },
          ui: {
            setWidget: (_key: string, value: typeof widget) => {
              widget = value;
            },
          },
        });
        const availability: boolean[] = [];
        const provider = registerActivityProvider(bus, {
          sessionId: "session",
          providerId: "agents",
          snapshot: () => [row("a")],
          invoke: () => Promise.resolve(),
          onAvailability: (value) => {
            availability.push(value);
          },
        });
        host.activate(ctx, service);
        expect(provider.isAvailable()).toBe(false);
        if (!Predicate.isFunction(widget)) throw new Error("Widget was not installed");
        // SAFETY: The widget factory only uses requestRender; it does not read theme values.
        widget(
          { requestRender() {} } as Parameters<typeof widget>[0],
          {} as Parameters<typeof widget>[1],
        );
        while (pending.length) yield* pending.shift()!;
        expect(provider.isAvailable()).toBe(true);
        host.deactivate();
        expect(provider.isAvailable()).toBe(false);
        expect(availability).toEqual([true, false]);
        provider.dispose();
      }),
  );
});
