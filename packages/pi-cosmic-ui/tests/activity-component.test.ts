import { describe, expect, it } from "@effect/vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityComponent } from "../src/activity/component.ts";
import { activityKey } from "../src/activity/protocol.ts";
import type { ActivityActionRequest } from "../src/activity/service.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
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
describe("activity presentation", () => {
  it("keeps route metadata visible beside long titles on wide widgets", () => {
    const agent = {
      ...row("Long task title ".repeat(30)),
      profile: "worker",
      route: "herdr/pi · provider/model:high",
      startedAt: 0,
    };
    for (const width of [100, 120, 160]) {
      const lines = renderActivityWidget([agent], width, 8, { now: 60_000 });
      expect(lines.join("\n")).toContain(agent.route);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(renderActivityWidget([agent], 80).join("\n")).not.toContain(agent.route);
  });
  it("hides the widget after activity ends but keeps startup and awaited work visible", () => {
    const finished: ActivityRow[] = [
      { ...row("success"), status: "done", inputTarget: undefined, blockedReason: undefined },
      { ...row("failure"), status: "failed", inputTarget: undefined, blockedReason: undefined },
      {
        ...row("cancelled"),
        status: "cancelled",
        inputTarget: undefined,
        blockedReason: undefined,
      },
    ];
    expect(renderActivityWidget([], 80)).toEqual([]);
    expect(renderActivityWidget(finished, 80)).toEqual([]);
    const active = row("active");
    const history = finished.map((item) => ({
      ...item,
      parent: { providerId: active.providerId, itemId: active.id },
    }));
    for (const collapsed of [new Set<string>(), new Set([active.key])]) {
      expect(
        renderActivityWidget(
          [{ ...active, omittedChildren: 3, omittedHistory: 2 }, ...history],
          80,
          8,
          { collapsed },
        ),
      ).toEqual(renderActivityWidget([active], 80, 8, { collapsed }));
    }
    expect(renderActivityWidget(finished, 80, 8, { starting: 1 }).length).toBeGreaterThan(0);
    for (const kind of ["agent", "command"] as const) {
      expect(
        renderActivityWidget([{ ...finished[0]!, kind, awaited: true }], 80).length,
      ).toBeGreaterThan(0);
    }
    expect(renderActivityWidget([row("running")], 80).length).toBeGreaterThan(0);
  });
  it("bounds profiles, long names, and collapsed branch warnings with and without await marks", () => {
    const owner = { ...row("a very long task name"), profile: "researcher", awaited: true };
    const child: ActivityRow = {
      ...row("question"),
      status: "needs-input",
      inputTarget: "user",
      blockedReason: undefined,
      parent: { providerId: owner.providerId, itemId: owner.id },
    };
    for (const width of [24, 32, 48]) {
      const lines = renderActivityWidget([owner, child], width, 8, {
        collapsed: new Set([owner.key]),
      });
      const unmarked = renderActivityWidget([{ ...owner, awaited: false }, child], width, 8, {
        collapsed: new Set([owner.key]),
      });
      for (const line of [...lines, ...unmarked])
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it("accepts only the latest detail refresh even for the same revision", () => {
    const deliveries: Array<(text: string) => void> = [];
    const component = new ActivityComponent({
      snapshot: () => [row("work")],
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
  it("uses tree arrows before pane navigation and restores list navigation when selection disappears", () => {
    const parent = row("parent");
    const child = { ...row("child"), parent: { providerId: "agents", itemId: "parent" } };
    let rows = [parent, child];
    let loads = 0;
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text, bold: (text) => text },
      height: () => 16,
      close: () => undefined,
      requestRender: () => undefined,
      loadDetail: () => {
        loads++;
      },
    });
    component.render(120);
    component.handleInput("\u001b[D");
    expect(component.presentation.collapsed.has(parent.key)).toBe(true);
    component.handleInput("\u001b[C");
    expect(component.presentation.collapsed.has(parent.key)).toBe(false);
    expect(component.shell.state.pane).toBe("list");
    expect(loads).toBe(0);
    component.handleInput("l");
    expect(component.shell.state.pane).toBe("detail");
    expect(loads).toBe(1);
    component.handleInput("h");
    expect(component.shell.state.pane).toBe("list");
    component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(child.key);
    component.handleInput("l");
    rows = [];
    component.render(120);
    expect(component.shell.state.pane).toBe("list");
  });
  it("can reopen an explicitly collapsed branch after it becomes finished history", () => {
    let rows: ActivityRow[] = [
      row("parent"),
      { ...row("child"), parent: { providerId: "agents", itemId: "parent" } },
    ];
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text, bold: (text) => text },
      height: () => 12,
      close: () => undefined,
      requestRender: () => undefined,
    });
    component.render(80);
    component.handleInput("c");
    rows = rows.map((entry) => ({
      ...entry,
      status: "done",
      inputTarget: undefined,
      blockedReason: undefined,
    }));
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
        ...(index === 15
          ? {
              status: "needs-input" as const,
              inputTarget: "user" as const,
              blockedReason: undefined,
            }
          : { status: "running" as const, inputTarget: undefined, blockedReason: undefined }),
      };
      if (index)
        Object.assign(entry, { parent: { providerId: "agents", itemId: String(index - 1) } });
      return entry;
    });
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
      inputTarget: "user" as const,
      blockedReason: undefined,
      parent: { providerId: "agents", itemId: "parent" },
    };
    const component = new ActivityComponent({
      snapshot: () => [parent, child, row("other")],
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
  it("n skips parent questions and blocked rows and preserves state when no human needs input", () => {
    const owner = row("owner");
    const parent: ActivityRow = {
      ...row("parent"),
      status: "needs-input",
      inputTarget: "parent",
      blockedReason: undefined,
    };
    const blocked: ActivityRow = {
      ...row("blocked"),
      status: "blocked",
      inputTarget: undefined,
      blockedReason: "file-access-review",
    };
    const human: ActivityRow = {
      ...row("human"),
      status: "needs-input",
      inputTarget: "user",
      blockedReason: undefined,
      parent: { providerId: owner.providerId, itemId: owner.id },
    };
    let rows = [owner, parent, blocked, human];
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text, bold: (text) => text },
      height: () => 12,
      close: () => undefined,
      requestRender: () => undefined,
    });
    component.render(80);
    component.handleInput("c");
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(human.key);
    expect(component.presentation.collapsed.has(owner.key)).toBe(false);
    rows = [owner, parent, blocked];
    component.render(80);
    component.handleInput("f");
    const selected = component.shell.state.selectedId;
    const focus = component.presentation.focus;
    const collapsed = [...component.presentation.collapsed];
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(selected);
    expect(component.presentation.focus).toBe(focus);
    expect([...component.presentation.collapsed]).toEqual(collapsed);
  });
  it("bounds persistent rows and every line at narrow and wide terminal sizes", () => {
    const rows = Array.from({ length: 80 }, (_, index) => row(`Long activity ${index} 界界界`));
    const component = new ActivityComponent({
      snapshot: () => rows,
      theme: { fg: (_color, text) => text, bold: (text) => text },
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
});
