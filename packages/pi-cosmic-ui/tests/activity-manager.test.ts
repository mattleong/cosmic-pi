import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { freshActivityPresentation } from "../src/activity/component.ts";
import { activitySectionId, groupedActivityTree } from "../src/activity/grouped-tree.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import type { ActivityActionRequest } from "../src/activity/service.ts";
import { activityRow, memberRow, mountActivity } from "./support/activity.ts";

type Mounted = ReturnType<typeof mountActivity>;

const numbered = (count: number) =>
  Arr.join(
    Arr.makeBy(count, (index) => `line ${index}`),
    "\n",
  );
const screen = ({ component }: Mounted, width: number) => Arr.join(component.render(width), "\n");
const press = ({ component }: Mounted, ...keys: string[]) => {
  for (const key of keys) component.handleInput(key);
};
const letters = (text: string) => Str.split(text, "");
const task = (id: string, status: ActivityRow["status"], overrides: Partial<ActivityRow> = {}) =>
  activityRow(id, status, undefined, { kind: "command", title: id, ...overrides });

describe("where a selected item's detail opens", () => {
  it("opens running work at its newest output and other work at its top", () => {
    const opened = (status: ActivityRow["status"]) => {
      const mounted = mountActivity(() => [task("work", status, { endedAt: 1 })], { height: 16 });
      mounted.component.render(120);
      mounted.loads.at(-1)!.deliver(numbered(60));
      return screen(mounted, 120);
    };
    expect(opened("running")).toMatch(/\bline 59\b/u);
    expect(opened("running")).not.toMatch(/\bline 0\b/u);
    for (const status of ["done", "failed", "pending"] as const) {
      expect(opened(status)).toMatch(/\bline 0\b/u);
      expect(opened(status)).not.toMatch(/\bline 59\b/u);
    }
  });

  it("keeps the reader's place when entering and leaving a stacked detail pane", () => {
    for (const [status, shown] of [
      ["done", /\bline 0\b/u],
      ["running", /\bline 59\b/u],
    ] as const) {
      const mounted = mountActivity(() => [task("work", status, { endedAt: 1 })], {
        height: 46,
      });
      mounted.component.render(57);
      mounted.loads.at(-1)!.deliver(numbered(60));
      expect(screen(mounted, 57)).toMatch(shown);
      press(mounted, "\r");
      expect(mounted.component.shell.state.pane).toBe("detail");
      expect(screen(mounted, 57)).toMatch(shown);
      press(mounted, "\u001b");
      expect(mounted.component.shell.state.pane).toBe("list");
      expect(screen(mounted, 57)).toMatch(shown);
    }
  });

  it("offers following only to work that can still produce output", () => {
    const reloadsWhenChanged = (status: ActivityRow["status"], keys: readonly string[]) => {
      let row = task("work", status, { endedAt: 1 });
      const mounted = mountActivity(() => [row], { height: 16 });
      mounted.component.render(120);
      press(mounted, "\r", ...keys);
      const before = mounted.loads.length;
      row = { ...row, revision: "2" };
      mounted.component.update();
      return mounted.loads.length > before;
    };
    expect(reloadsWhenChanged("running", [])).toBe(true);
    expect(reloadsWhenChanged("running", ["f"])).toBe(false);
    expect(reloadsWhenChanged("running", ["f", "f"])).toBe(true);
    expect(reloadsWhenChanged("pending", ["f"])).toBe(false);
    const question = activityRow("ask", "needs-input", undefined, { kind: "question" });
    let current = question;
    const asked = mountActivity(() => [current], { height: 16 });
    asked.component.render(120);
    press(asked, "\r", "f");
    const before = asked.loads.length;
    current = { ...question, revision: "2" };
    asked.component.update();
    expect(asked.loads.length).toBe(before);
  });
});

describe("previewed and inspected detail", () => {
  it("previews the short form of a section and shows its fuller body once inspected", () => {
    const mounted = mountActivity(() => [activityRow("agent", "done")], { height: 20 });
    mounted.component.render(120);
    mounted.loads.at(-1)!.deliverDetail({
      sections: [
        {
          title: "Recent activity",
          body: "✓ read · src/thing.ts",
          expandedBody: "✓ read · src/thing.ts\n  export const thing = 1;",
        },
      ],
    });
    const preview = screen(mounted, 120);
    expect(preview).toContain("src/thing.ts");
    expect(preview).not.toContain("export const thing");
    press(mounted, "\r");
    expect(screen(mounted, 120)).toContain("export const thing");
    press(mounted, "\u001b");
    expect(screen(mounted, 120)).not.toContain("export const thing");
  });

  it("keeps a finished parent's preview at its top when the parent is folded and unfolded", () => {
    const lead = activityRow("lead", "done", undefined, { title: "Lead", endedAt: 1 });
    const child = memberRow("child", lead, "done");
    const mounted = mountActivity(() => [lead, child], { height: 16 });
    mounted.component.render(140);
    mounted.loads.at(-1)!.deliver(numbered(60));
    expect(mounted.component.shell.state.selectedId).toBe(lead.key);
    expect(screen(mounted, 140)).toMatch(/\bline 0\b/u);
    for (const key of ["h", "l"]) {
      press(mounted, key);
      expect(screen(mounted, 140)).toMatch(/\bline 0\b/u);
      expect(screen(mounted, 140)).not.toMatch(/\bline 59\b/u);
    }
  });

  it("previews a parent with a rollup of its direct children", () => {
    const lead = activityRow("lead", "running", undefined, { title: "Lead" });
    const children = Arr.makeBy(8, (index) =>
      memberRow(`child-${index}`, lead, index < 3 ? "running" : "pending"),
    );
    const mounted = mountActivity(() => [lead, ...children], { height: 30 });
    // The detail column alone; the list beside it names every child.
    const shown = Arr.join(
      Arr.map(mounted.component.render(140), (line) => Str.split(line, "│")[2] ?? ""),
      "\n",
    );
    expect(mounted.component.shell.state.selectedId).toBe(lead.key);
    for (const index of [0, 1, 2, 3, 4, 5]) expect(shown).toContain(`child-${index}`);
    expect(shown).not.toContain("child-6");
    expect(shown).not.toContain("child-7");
  });
});

describe("what needs the user comes first", () => {
  it("orders sections Attention, Subagents, Tasks", () => {
    const tree = groupedActivityTree([
      task("build", "running"),
      activityRow("agent", "running"),
      activityRow("ask", "needs-input", undefined, { kind: "question" }),
    ]);
    const sections = Arr.filter(tree, (entry) => entry.type === "section");
    expect(Arr.map(sections, (entry) => entry.id)).toEqual([
      activitySectionId("attention"),
      activitySectionId("subagents"),
      activitySectionId("tasks"),
    ]);
  });

  it("selects the first item waiting on the user over a remembered selection", () => {
    const build = task("build", "running");
    const question = activityRow("ask", "needs-input", undefined, { kind: "question" });
    const presentation = freshActivityPresentation();
    mountActivity(() => [build], { presentation }).component.render(120);
    expect(presentation.shell.state.selectedId).toBe(build.key);
    mountActivity(() => [build, question], { presentation }).component.render(120);
    expect(presentation.shell.state.selectedId).toBe(question.key);
  });

  it("keeps /tasks on its section, preferring a waiting item inside it", () => {
    const build = task("build", "running");
    const standalone = activityRow("ask", "needs-input", undefined, { kind: "question" });
    const tasks = mountActivity(() => [standalone, build], { initialSection: "tasks" });
    tasks.component.render(120);
    expect(tasks.component.shell.state.selectedId).toBe(build.key);
    const nested = activityRow("nested", "needs-input", build.id, { kind: "question" });
    const inside = mountActivity(() => [standalone, build, nested], { initialSection: "tasks" });
    inside.component.render(120);
    expect(inside.component.shell.state.selectedId).toBe(nested.key);
  });
});

describe("filtering the tree", () => {
  const stop = { id: "stop", label: "Stop", handoff: false };
  const lead = activityRow("lead", "running", undefined, { title: "Lead" });
  const rows = [
    lead,
    memberRow("unit", lead, "failed", { title: "Unit tests", endedAt: 1 }),
    task("flaky build", "failed", { endedAt: 1 }),
    task("lint", "running", { actions: [stop] }),
  ];
  const mountFiltered = () => {
    const invoked: ActivityActionRequest[] = [];
    const mounted = mountActivity(() => rows, {
      height: 30,
      invoke: (request) => {
        invoked.push(request);
      },
    });
    mounted.component.render(140);
    return { mounted, invoked };
  };

  it("keeps matches by status word with their owners and drops sections without one", () => {
    const { mounted } = mountFiltered();
    press(mounted, "/", ...letters("failed"));
    const shown = screen(mounted, 140);
    for (const title of ["Lead", "Unit tests", "flaky build"]) expect(shown).toContain(title);
    expect(shown).not.toContain("lint");
    press(mounted, "\u001b", "/", ...letters("lead"));
    const byTitle = screen(mounted, 140);
    expect(byTitle).toContain("Lead");
    expect(byTitle).not.toContain("flaky build");
    expect(byTitle).not.toContain("Tasks");
  });

  it("types action letters into the filter instead of running them", () => {
    const { mounted, invoked } = mountFiltered();
    press(mounted, "G", "k");
    expect(mounted.component.shell.state.selectedId).toBe(rows[3]!.key);
    press(mounted, "/", "x");
    expect(invoked).toEqual([]);
    expect(screen(mounted, 140)).not.toContain("lint");
    press(mounted, "\u001b");
    expect(screen(mounted, 140)).toContain("lint");
    press(mounted, "x");
    expect(invoked[0]).toMatchObject({ key: rows[3]!.key, actionId: "stop" });
  });

  it("clears an applied filter with Esc before the next Esc closes", () => {
    const { mounted } = mountFiltered();
    press(mounted, "/", ...letters("flaky"), "\r", "j");
    expect(screen(mounted, 140)).not.toContain("lint");
    press(mounted, "\u001b");
    expect(mounted.closed).toEqual([]);
    expect(screen(mounted, 140)).toContain("lint");
    press(mounted, "\u001b");
    expect(mounted.closed).toHaveLength(1);
  });
});

describe("section headings", () => {
  it("fold and unfold with Enter and are never entered", () => {
    const mounted = mountActivity(() => [task("build", "running")], { height: 16 });
    mounted.component.render(120);
    press(mounted, "k");
    expect(mounted.component.shell.state.selectedId).toBe(activitySectionId("tasks"));
    press(mounted, "\r");
    expect(mounted.component.shell.state.pane).toBe("list");
    expect(screen(mounted, 120)).not.toContain("build");
    press(mounted, "\r");
    expect(screen(mounted, 120)).toContain("build");
    press(mounted, "l");
    expect(mounted.component.shell.state.pane).toBe("list");
  });

  it("offer section-wide actions on the heading, and their keys still work from a row", () => {
    const clear = {
      id: "clear",
      label: "Clear all finished",
      confirmation: "Clear all finished tasks?",
      handoff: false,
      scope: "section" as const,
    };
    const old = task("old build", "done", { endedAt: 1, actions: [clear] });
    const invoked: ActivityActionRequest[] = [];
    const mounted = mountActivity(() => [task("server", "running"), old], {
      height: 20,
      invoke: (request) => {
        invoked.push(request);
      },
    });
    mounted.component.render(140);
    press(mounted, "j");
    expect(mounted.component.shell.state.selectedId).toBe(old.key);
    expect(screen(mounted, 140)).not.toContain(clear.label);
    press(mounted, "c", "\r");
    expect(invoked[0]).toMatchObject({ key: old.key, actionId: "clear" });
    press(mounted, "k", "k");
    expect(mounted.component.shell.state.selectedId).toBe(activitySectionId("tasks"));
    expect(screen(mounted, 140)).toContain(clear.label);
    press(mounted, "c", "\r");
    expect(invoked[1]).toMatchObject({ key: old.key, actionId: "clear" });
  });
});
