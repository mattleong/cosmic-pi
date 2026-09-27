import { describe, expect, it } from "@effect/vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityRow } from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityRow, mountActivity } from "./support/activity.ts";

const routed = activityRow("Long task title ".repeat(30), "running", undefined, {
  profile: "worker",
  route: "herdr/pi · provider/model:high",
  startedAt: 0,
});
const owner = activityRow("a very long task name", "running", undefined, {
  profile: "researcher",
  awaited: true,
});
const question = activityRow("question", "needs-input", owner.id);
const hierarchy = Array.from({ length: 16 }, (_, index) =>
  activityRow(
    String(index),
    index === 15 ? "needs-input" : "running",
    index ? String(index - 1) : undefined,
    {
      title: "长い所有者の名前 ".repeat(8),
      kind: index === 15 ? "question" : index === 14 ? "command" : "agent",
    },
  ),
);
const persistent = Array.from({ length: 80 }, (_, index) =>
  activityRow(`Long activity ${index} 界界界`),
);
const collapsedOwner = { collapsed: new Set([owner.key]) };

describe("activity presentation", () => {
  it.each([
    ["long titles beside route metadata", [routed], { now: 60_000 }],
    ["collapsed awaited branch warnings", [owner, question], collapsedOwner],
    ["collapsed branch warnings", [{ ...owner, awaited: false }, question], collapsedOwner],
    ["a typed deep hierarchy", hierarchy, {}],
    ["persistent rows", persistent, {}],
  ] as const)("bounds %s at narrow and wide terminal sizes", (_name, rows, options) => {
    const { component } = mountActivity(() => rows, { height: 20 });
    for (const width of [0, 1, 2, 8, 21, 22, 24, 29, 30, 32, 47, 48, 59, 60, 70, 100, 120, 160]) {
      const widget = renderActivityWidget(rows, width, 8, options);
      expect(widget.length).toBeLessThanOrEqual(8);
      for (const line of [...widget, ...component.render(width)])
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
  it("keeps route metadata visible beside long titles on wide widgets", () => {
    for (const width of [100, 120, 160])
      expect(renderActivityWidget([routed], width, 8, { now: 60_000 }).join("\n")).toContain(
        routed.route,
      );
  });
  it("hides the widget after activity ends but keeps startup and awaited work visible", () => {
    const finished = [
      activityRow("success", "done"),
      activityRow("failure", "failed"),
      activityRow("cancelled", "cancelled"),
    ];
    expect(renderActivityWidget([], 80)).toEqual([]);
    expect(renderActivityWidget(finished, 80)).toEqual([]);
    const active = activityRow("active");
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
    expect(renderActivityWidget([activityRow("running")], 80).length).toBeGreaterThan(0);
  });
  it("accepts only the latest detail refresh even for the same revision", () => {
    const deliveries: Array<(text: string) => void> = [];
    const { component } = mountActivity(() => [activityRow("work")], {
      height: 16,
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
    let current = activityRow("work");
    const deliveries: Array<(text: string) => void> = [];
    const logs = (count: number) =>
      Array.from({ length: count }, (_, index) => `log-${index}`).join("\n");
    const { component } = mountActivity(() => [current], {
      height: 16,
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
    const parent = activityRow("parent");
    const child = activityRow("child", "running", "parent");
    let rows = [parent, child];
    let loads = 0;
    const { component } = mountActivity(() => rows, {
      height: 16,
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
    let rows: ActivityRow[] = [activityRow("parent"), activityRow("child", "running", "parent")];
    const { component } = mountActivity(() => rows);
    component.render(80);
    component.handleInput("h");
    rows = rows.map((entry) => activityRow(entry.id, "done", entry.parent?.itemId));
    component.render(80);
    component.handleInput("l");
    component.render(80);
    component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(rows[1]!.key);
  });
  it("jumps from a typed deep hierarchy to the question that needs you", () => {
    const { component } = mountActivity(() => hierarchy, { height: 20 });
    component.render(100);
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(hierarchy[15]!.key);
  });
  it("keeps selection identity when live rows reorder and dispatches only explicit actions", () => {
    let rows = [
      activityRow("a"),
      { ...activityRow("b"), actions: [{ id: "open", label: "Open" }] },
    ];
    const { component, closed } = mountActivity(() => rows);
    component.render(80);
    component.handleInput("j");
    rows = [rows[1]!, rows[0]!];
    component.render(80);
    expect(component.shell.state.selectedId).toBe(activityRow("b").key);
    component.handleInput("1");
    expect(closed[0]).toMatchObject({ key: activityRow("b").key, revision: "1", actionId: "open" });
  });
  it("dispatches the displayed capability rather than a changed action occupying its key", () => {
    let current = { ...activityRow("a"), actions: [{ id: "open", label: "Open" }] };
    const { component, closed } = mountActivity(() => [current]);
    component.render(80);
    current = { ...current, revision: "2", actions: [{ id: "stop", label: "Stop" }] };
    component.handleInput("1");
    expect(closed[0]).toMatchObject({ revision: "1", actionId: "open" });
  });
  it("requires a separate confirmation and retains the displayed destructive scope", () => {
    let current = {
      ...activityRow("a"),
      actions: [
        {
          id: "stop",
          label: "Stop branch",
          confirmation: "Stop this branch and its two descendants?",
        },
      ],
    };
    const { component, closed } = mountActivity(() => [current], {
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
    let current = activityRow("a");
    let loads = 0;
    const { component } = mountActivity(() => [current], {
      height: 20,
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
      ...activityRow("a"),
      actions: Array.from({ length: 16 }, (_, index) => ({
        id: String(index),
        label: String(index),
      })),
    };
    const { component, closed } = mountActivity(() => [current]);
    component.render(80);
    component.handleInput("a");
    component.render(80);
    component.handleInput("7");
    expect(closed[0]?.actionId).toBe("15");
  });
  it("focuses and collapses branches without losing access to needs-you children", () => {
    const parent = activityRow("parent");
    const child = activityRow("question", "needs-input", "parent", { kind: "question" });
    const other = activityRow("other");
    const { component } = mountActivity(() => [parent, child, other]);
    component.presentation.collapsed.add(other.key);
    component.render(40);
    component.handleInput("h");
    component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(other.key);
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(child.key);
    expect(component.presentation.collapsed.has(other.key)).toBe(true);
    component.handleInput("z");
    component.render(40);
    expect(component.shell.state.selectedId).toBe(child.key);
  });
  it("n skips parent questions and blocked rows and preserves state when no human needs input", () => {
    const owner = activityRow("owner");
    const parent = activityRow("parent", "needs-input", undefined, { inputTarget: "parent" });
    const blocked = activityRow("blocked", "blocked", undefined, {
      blockedReason: "file-access-review",
    });
    const human = activityRow("human", "needs-input", owner.id);
    let rows = [owner, parent, blocked, human];
    const { component } = mountActivity(() => rows);
    component.render(80);
    component.handleInput("h");
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(human.key);
    expect(component.presentation.collapsed.has(owner.key)).toBe(false);
    rows = [owner, parent, blocked];
    component.render(80);
    component.handleInput("z");
    const selected = component.shell.state.selectedId;
    const focus = component.presentation.focus;
    const collapsed = [...component.presentation.collapsed];
    component.handleInput("n");
    expect(component.shell.state.selectedId).toBe(selected);
    expect(component.presentation.focus).toBe(focus);
    expect([...component.presentation.collapsed]).toEqual(collapsed);
  });
});
