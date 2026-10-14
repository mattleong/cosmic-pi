import { describe, expect, it } from "@effect/vitest";
import * as Match from "effect/Match";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityRow } from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityRow, memberRow, mountActivity, withStatus } from "./support/activity.ts";
import { activitySectionId } from "../src/activity/grouped-tree.ts";
import type { ActivityActionRequest } from "../src/activity/service.ts";

const routed = activityRow("Long task title ".repeat(30), "running", undefined, {
  profile: "worker",
  route: "local/pi · provider/model:high",
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
      kind: Match.value(index).pipe(
        Match.when(15, () => "question" as const),
        Match.when(14, () => "command" as const),
        Match.orElse(() => "agent" as const),
      ),
    },
  ),
);
const persistent = Array.from({ length: 80 }, (_, index) =>
  activityRow(`Long activity ${index} 界界界`),
);
const collapsedOwner = { collapsed: new Set([owner.key]) };

const logs = (count: number) =>
  Array.from({ length: count }, (_, index) => `log-${index}`).join("\n");

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
  it("keeps the start of a long parent title beside its collapsed attention at narrow widths", () => {
    const parent = activityRow("parent", "running", undefined, {
      title: "Migrate every billing service to the consolidated settings schema",
      startedAt: 0,
    });
    const rows = [
      parent,
      memberRow("built", parent, "done", { startedAt: 0, endedAt: 1000 }),
      ...[0, 1, 2].map((index) => memberRow(`blocked-${index}`, parent, "blocked")),
      memberRow("live", parent, "running", { startedAt: 0 }),
    ];
    const collapsed = new Set([parent.key]);
    for (const width of [60, 80, 100]) {
      const line = renderActivityWidget(rows, width, 8, { now: 90_000, collapsed })[0]!;
      expect(line).toContain("Migrate");
      expect(line).toMatch(/\b3\b/u);
    }
    const { component } = mountActivity(() => rows, { height: 20 });
    component.render(140);
    component.handleInput("h");
    for (const width of [80, 100, 140]) {
      const line = component.render(width).find((text) => text.includes("Migrate"));
      expect(line).toMatch(/\b3\b/u);
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
        renderActivityWidget([{ ...active, omittedChildren: 3 }, ...history], 80, 8, { collapsed }),
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
    const { component, loads } = mountActivity(() => [activityRow("work")], { height: 16 });
    component.render(120);
    component.handleInput("\r");
    loads[0]!.deliver("baseline-log");
    component.handleInput("r");
    component.handleInput("r");
    loads[1]!.deliver("obsolete-log");
    expect(component.render(120).join("\n")).toContain("baseline-log");
    loads[2]!.deliver("latest-log");
    loads[1]!.deliver("obsolete-log");
    const text = component.render(120).join("\n");
    expect(text).toContain("latest-log");
    expect(text).not.toContain("obsolete-log");
  });
  it("keeps viewed log lines steady on refresh and freshness changes", () => {
    let current = activityRow("work");
    const { component, loads } = mountActivity(() => [current], { height: 16 });
    const visibleLogs = () =>
      component
        .render(120)
        .join("\n")
        .match(/log-\d+/g);
    component.render(120);
    component.handleInput("\r");
    loads[0]!.deliver(logs(30));
    const original = visibleLogs();
    expect(original?.length).toBeGreaterThan(0);
    component.handleInput("r");
    component.render(120);
    loads[1]!.deliver(logs(40));
    expect(visibleLogs()?.slice(0, original?.length)).toEqual(original);
    component.handleInput("k");
    const scrolled = visibleLogs();
    current = { ...current, revision: "2" };
    expect(visibleLogs()).toEqual(scrolled);
    component.handleInput("r");
    loads[2]!.deliver(logs(45));
    expect(visibleLogs()).toEqual(scrolled);
  });
  it("says why work that never started was cancelled, on its row", () => {
    const parent = activityRow("parent");
    const refused = memberRow("refused", parent, "cancelled", {
      summary: "over budget",
      endedAt: 5,
    });
    const { component } = mountActivity(() => [parent, refused], { height: 20 });
    const line = component.render(140).find((text) => text.includes("refused"));
    expect(line).toContain("over budget");
  });
  it("opens a newly selected item's detail at its first lines and lets the reader move it", () => {
    const text = Array.from({ length: 60 }, (_, index) => `line-${index}`).join("\n");
    const { component, loads } = mountActivity(() => [activityRow("work")], { height: 16 });
    const visible = () =>
      component
        .render(120)
        .join("\n")
        .match(/line-\d+/g) ?? [];
    component.render(120);
    component.handleInput("\r");
    loads[0]!.deliver(text);
    const opened = visible();
    expect(opened[0]).toBe("line-0");
    expect(opened).not.toContain("line-59");
    expect(visible()).toEqual(opened);
    component.handleInput("j");
    const moved = visible();
    expect(moved).not.toEqual(opened);
    expect(visible()).toEqual(moved);
  });
  it("uses tree arrows before pane navigation and restores list navigation when selection disappears", () => {
    const parent = activityRow("parent");
    const child = activityRow("child", "running", "parent");
    let rows = [parent, child];
    const { component, loads } = mountActivity(() => rows, { height: 16 });
    component.render(120);
    component.handleInput("\u001b[D");
    expect(component.presentation.collapsed.has(parent.key)).toBe(true);
    component.handleInput("\u001b[C");
    expect(component.presentation.collapsed.has(parent.key)).toBe(false);
    expect(component.shell.state.pane).toBe("list");
    expect(loads).toHaveLength(0);
    component.handleInput("l");
    expect(component.shell.state.pane).toBe("detail");
    expect(loads).toHaveLength(1);
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
    component.handleInput("w");
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
    const stop = {
      id: "stop",
      label: "Stop branch",
      confirmation: "Stop this branch and its two descendants?",
      handoff: false,
    };
    let current = { ...activityRow("a"), actions: [stop] };
    const invoked: ActivityActionRequest[] = [];
    const { component, closed } = mountActivity(() => [current], {
      matchesKeybinding: (data, id) => data === "accept" && id === "tui.select.confirm",
      invoke: (request) => {
        invoked.push(request);
      },
    });
    component.render(80);
    component.handleInput("1");
    component.handleInput("1");
    expect(invoked).toEqual([]);
    current = { ...current, revision: "2", summary: "still running" };
    component.handleInput("accept");
    expect(invoked[0]).toMatchObject({ revision: "2", actionId: "stop" });
    component.render(80);
    component.handleInput("1");
    current = {
      ...current,
      revision: "3",
      actions: [{ ...stop, confirmation: "Stop this branch and its three descendants?" }],
    };
    component.handleInput("accept");
    expect(invoked[1]).toMatchObject({ revision: "2", actionId: "stop" });
    expect(closed).toEqual([]);
  });
  it("keeps inspected detail across revisions until explicit refresh", () => {
    let current = activityRow("a");
    const { component, loads } = mountActivity(() => [current], { height: 20 });
    component.render(120);
    component.handleInput("\r");
    loads[0]!.deliver("log-1");
    expect(component.render(120).join("\n")).toContain("log-1");
    current = { ...current, revision: "2" };
    expect(component.render(120).join("\n")).toContain("log-1");
    expect(loads).toHaveLength(1);
    component.handleInput("r");
    loads[1]!.deliver("log-2");
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
    component.handleInput("w");
    expect(component.shell.state.selectedId).toBe(child.key);
    expect(component.presentation.collapsed.has(other.key)).toBe(true);
    component.handleInput("z");
    component.render(40);
    expect(component.shell.state.selectedId).toBe(child.key);
  });
  it("n skips parent questions and blocked rows and preserves state when no human needs input", () => {
    const questionOwner = activityRow("owner");
    const parent = activityRow("parent", "needs-input", undefined, { inputTarget: "parent" });
    const blocked = activityRow("blocked", "blocked", undefined, {
      blockedReason: "file-access-review",
    });
    const human = activityRow("human", "needs-input", questionOwner.id);
    let rows = [questionOwner, parent, blocked, human];
    const { component } = mountActivity(() => rows);
    component.render(80);
    component.handleInput("h");
    component.handleInput("w");
    expect(component.shell.state.selectedId).toBe(human.key);
    expect(component.presentation.collapsed.has(questionOwner.key)).toBe(false);
    rows = [questionOwner, parent, blocked];
    component.render(80);
    component.handleInput("z");
    const selected = component.shell.state.selectedId;
    const focus = component.presentation.focus;
    const collapsed = [...component.presentation.collapsed];
    component.handleInput("w");
    expect(component.shell.state.selectedId).toBe(selected);
    expect(component.presentation.focus).toBe(focus);
    expect([...component.presentation.collapsed]).toEqual(collapsed);
  });
});

// A task parent keeps nested subagents out of the subagents section, so initial
// section selection has to reveal them rather than pick the parent.
const reviewParent = (overrides: Partial<ActivityRow> = {}) =>
  activityRow("review", "running", undefined, { kind: "command", ...overrides });
const mountGrouped = (
  snapshot: () => readonly ActivityRow[],
  options: Parameters<typeof mountActivity>[1] = {},
) => mountActivity(snapshot, { height: 24, ...options });

describe("grouped activity interaction", () => {
  it("traverses a parent row and its members, fetching only source details", () => {
    const parent = reviewParent({ detail: "parent-evidence" });
    const worker = memberRow("worker", parent);
    const { component, closed, loads } = mountGrouped(() => [parent, worker]);
    component.render(140);
    expect(component.shell.state.selectedId).toBe(parent.key);
    expect(loads).toEqual([]);
    component.handleInput("\r");
    expect(loads[0]!.request).toEqual({
      key: parent.key,
      revision: parent.revision,
      generation: parent.generation,
    });
    loads[0]!.deliver("live-parent-evidence");
    expect(component.render(140).join("\n")).toContain("live-parent-evidence");
    component.handleInput("h");
    component.handleInput("k");
    expect(component.shell.state.selectedId).toBe(activitySectionId("tasks"));
    component.handleInput("\r");
    for (const key of ["1", "x", "m", "r", "f"]) component.handleInput(key);
    expect(loads).toHaveLength(1);
    component.handleInput("h");
    component.handleInput("j");
    component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(worker.key);
    component.handleInput("\r");
    expect(loads[1]!.request.key).toBe(worker.key);
    expect(closed).toEqual([]);
    for (const width of [30, 80, 140])
      expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });
  it("dispatches only displayed parent actions with confirmation and captured revision", () => {
    let parent = reviewParent({
      actions: [{ id: "stop", label: "Stop task", confirmation: "Stop this task?" }],
    });
    const { component, closed } = mountGrouped(() => [parent]);
    component.render(140);
    component.handleInput("m");
    expect(closed).toEqual([]);
    component.handleInput("x");
    expect(closed).toEqual([]);
    parent = { ...parent, revision: "2", actions: [] };
    component.update();
    component.handleInput("\r");
    expect(closed).toEqual([
      { key: parent.key, revision: "1", generation: parent.generation, actionId: "stop" },
    ]);
  });
  it("confirms an action with the direct key that asked for it, never another key", () => {
    const parent = reviewParent({
      actions: [{ id: "stop", label: "Stop task", confirmation: "Stop this task?" }],
    });
    const { component, closed } = mountGrouped(() => [parent]);
    component.render(140);
    component.handleInput("1");
    component.handleInput("x");
    component.handleInput("1");
    expect(closed).toEqual([]);
    component.handleInput("\u001b");
    component.handleInput("x");
    component.handleInput("i");
    expect(closed).toEqual([]);
    component.handleInput("x");
    expect(closed).toEqual([
      { key: parent.key, revision: "1", generation: parent.generation, actionId: "stop" },
    ]);
  });
  it("runs only actions declared without handoff in place and closes first for the rest", () => {
    const parent = reviewParent({
      actions: [
        {
          id: "stop",
          label: "Stop task",
          confirmation: "Stop this task?",
          handoff: false,
        },
      ],
    });
    const queued = memberRow("queued", parent, "pending", {
      actions: [{ id: "stop", label: "Stop", handoff: false }],
    });
    const asking = memberRow("asking", parent, "needs-input", {
      actions: [{ id: "reply", label: "Reply" }],
    });
    const invoked: ActivityActionRequest[] = [];
    const { component, closed } = mountGrouped(() => [parent, queued, asking], {
      invoke: (request) => {
        invoked.push(request);
      },
    });
    const select = (row: ActivityRow) => {
      component.render(140);
      component.handleInput("g");
      component.handleInput("g");
      for (let step = 0; step < 8 && component.shell.state.selectedId !== row.key; step++)
        component.handleInput("j");
      expect(component.shell.state.selectedId).toBe(row.key);
      component.render(140);
    };
    select(queued);
    component.handleInput("x");
    expect(invoked).toEqual([
      { key: queued.key, generation: 1, revision: queued.revision, actionId: "stop" },
    ]);
    expect(closed).toEqual([]);
    select(parent);
    component.handleInput("x");
    component.handleInput("\r");
    expect(invoked.map((request) => request.actionId)).toEqual(["stop", "stop"]);
    expect(closed).toEqual([]);
    select(asking);
    component.handleInput("m");
    expect(closed).toEqual([
      { key: asking.key, generation: 1, revision: asking.revision, actionId: "reply" },
    ]);
    expect(invoked).toHaveLength(2);
  });
  it("rejects stale parent detail delivery and never offers retained actions", () => {
    let parent = reviewParent({
      status: "done",
      actions: [{ id: "clear", label: "Clear" }],
    });
    const { component, closed, loads } = mountGrouped(() => [parent]);
    component.render(140);
    component.handleInput("\r");
    parent = { ...parent, revision: "2" };
    loads[0]!.deliver("outdated-detail");
    expect(component.render(140).join("\n")).not.toContain("outdated-detail");
    component.handleInput("r");
    loads[1]!.deliver("fresh-detail");
    expect(component.render(140).join("\n")).toContain("fresh-detail");
    parent = { ...parent, retained: true };
    component.update();
    loads[1]!.deliver("revoked-detail");
    component.render(140);
    for (const key of ["1", "c", "r", "f"]) component.handleInput(key);
    expect(loads).toHaveLength(2);
    expect(closed).toEqual([]);
    expect(component.render(140).join("\n")).not.toContain("revoked-detail");
  });
  it.each(["subagents", "tasks"] as const)(
    "opens %s on standalone work or reveals the matching nested member",
    (section) => {
      const kind = section === "tasks" ? "command" : "agent";
      const parent = reviewParent({ kind: kind === "command" ? "agent" : "command" });
      const member = memberRow("member", parent, "running", { kind });
      const standalone = activityRow("standalone", "running", undefined, { kind });
      for (const rows of [
        [parent, member],
        [parent, member, standalone],
      ]) {
        const { component } = mountGrouped(() => rows, { initialSection: section });
        component.presentation.collapsed.add(parent.key);
        component.render(120);
        expect(component.shell.state.selectedId).toBe(
          rows.length === 3 ? standalone.key : member.key,
        );
        expect(component.presentation.focus).toBeUndefined();
        if (rows.length === 2) expect(component.presentation.collapsed.has(parent.key)).toBe(false);
        component.handleInput("g");
        component.handleInput("g");
        expect(component.shell.state.selectedId).toBe(activitySectionId("subagents"));
      }
    },
  );
  it("keeps a selected member through settlement, history and resize", () => {
    let parent = reviewParent();
    let member = memberRow("member", parent);
    const { component } = mountGrouped(() => [parent, member], {
      initialSection: "subagents",
    });
    component.render(120);
    expect(component.shell.state.selectedId).toBe(member.key);
    parent = withStatus(parent, "done", { revision: "2" });
    member = withStatus(member, "done", { revision: "2" });
    component.update();
    for (const width of [20, 80, 160]) {
      component.render(width);
      expect(component.shell.state.selectedId).toBe(member.key);
    }
    component.handleInput("h");
    expect(component.shell.state.selectedId).toBe(parent.key);
  });
  it("keeps a queued selection when its placeholder starts running", () => {
    const parent = reviewParent();
    let member = memberRow("member", parent, "pending");
    const { component } = mountGrouped(() => [parent, member], {
      initialSection: "subagents",
    });
    component.render(120);
    member = withStatus(member, "running", { startedAt: 10, revision: "2" });
    component.update();
    component.render(120);
    expect(component.shell.state.selectedId).toBe(member.key);
  });
  it("reveals urgent owned questions across collapsed parent and section headings", () => {
    const parent = reviewParent();
    const findMember = memberRow("owner", parent);
    const human = activityRow("human", "needs-input", findMember.id, { kind: "question" });
    const { component } = mountGrouped(() => [parent, findMember, human]);
    component.render(120);
    component.presentation.collapsed.add(parent.key);
    component.presentation.collapsed.add(activitySectionId("tasks"));
    component.handleInput("w");
    expect(component.shell.state.selectedId).toBe(human.key);
    expect(component.presentation.collapsed.has(parent.key)).toBe(false);
    expect(component.presentation.collapsed.has(activitySectionId("tasks"))).toBe(false);
  });
  it("follows only by explicit opt-in plus host update, never during rendering or resize", () => {
    let row = activityRow("task", "running", undefined, { kind: "command" });
    const { component, loads, cancels } = mountGrouped(() => [row], { initialSection: "tasks" });
    for (const width of [80, 30, 160]) {
      component.invalidate();
      component.render(width);
    }
    component.update();
    expect(loads).toEqual([]);
    expect(cancels()).toBe(0);
    component.handleInput("\r");
    loads[0]!.deliver("baseline-log");
    row = { ...row, revision: "2" };
    component.update();
    expect(loads).toHaveLength(1);
    component.handleInput("f");
    loads[1]!.deliver("followed-log");
    row = { ...row, revision: "3" };
    for (const width of [80, 40, 160]) component.render(width);
    expect(loads).toHaveLength(2);
    component.update();
    expect(loads[2]?.request.revision).toBe("3");
    component.handleInput("f");
    expect(cancels()).toBeGreaterThan(0);
    loads[2]!.deliver("cancelled-log");
    expect(component.render(120).join("\n")).toContain("followed-log");
    expect(component.render(120).join("\n")).not.toContain("cancelled-log");
  });
  it("cancels source loads when selection moves to the parent and never revives a stale callback", () => {
    const parent = reviewParent();
    const member = memberRow("member", parent);
    const { component, loads, cancels } = mountGrouped(() => [parent, member], {
      initialSection: "subagents",
    });
    component.render(120);
    component.handleInput("\r");
    component.handleInput("f");
    component.handleInput("h");
    component.handleInput("h");
    expect(cancels()).toBeGreaterThan(0);
    expect(component.shell.state.selectedId).toBe(parent.key);
    component.handleInput("j");
    loads[1]!.deliver("revoked-log");
    expect(component.render(120).join("\n")).not.toContain("revoked-log");
    component.handleInput("q");
    loads[0]!.deliver("closed-log");
    expect(component.render(120).join("\n")).not.toContain("closed-log");
  });
  it.each([
    ["x", "stop"],
    ["i", "interrupt"],
    ["u", "resume"],
    ["m", "reply"],
    ["m", "message"],
    ["e", "rename"],
    ["c", "clear"],
  ])("keeps the %s source shortcut revision-safe for %s", (key, actionId) => {
    const parent = reviewParent();
    let row = memberRow("member", parent, "running", {
      actions: [{ id: actionId, label: "Action" }],
    });
    const { component, closed } = mountGrouped(() => [parent, row], {
      initialSection: "subagents",
    });
    component.render(120);
    row = { ...row, revision: "replacement", actions: [] };
    component.handleInput(key);
    expect(closed[0]).toMatchObject({ key: row.key, revision: "1", actionId });
  });
  it("never dispatches an old source generation after provider replacement", () => {
    let row = activityRow("same", "running", undefined, {
      actions: [{ id: "stop", label: "Stop" }],
    });
    const { component, closed } = mountGrouped(() => [row], { initialSection: "subagents" });
    component.render(120);
    row = { ...row, generation: 2 };
    component.handleInput("x");
    component.handleInput("1");
    expect(closed).toEqual([]);
    component.render(120);
    component.handleInput("x");
    expect(closed[0]).toMatchObject({ generation: 2 });
  });
  it("keeps retained member evidence non-executable even if it still advertises actions", () => {
    const parent = reviewParent({ status: "done" });
    const row = {
      ...memberRow("old", parent, "done", { actions: [{ id: "clear", label: "Clear" }] }),
      retained: true as const,
    };
    const { component, closed, loads } = mountGrouped(() => [parent, row], {
      initialSection: "subagents",
    });
    component.render(120);
    expect(component.shell.state.selectedId).toBe(row.key);
    for (const key of ["\r", "1", "c", "r", "f"]) component.handleInput(key);
    expect(loads).toEqual([]);
    expect(closed).toEqual([]);
  });
});
