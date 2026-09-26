// Behavior-first component tests for the /subagents fleet: expandable hierarchy,
// selection identity across reorder, Esc detail → list → close, and pending action/prompt
// clearing on identity change. Assertions use transitions and callbacks, not exact chrome.
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  SubagentFleetComponent,
  type FleetActions,
  type FleetKeybindingId,
} from "../src/ui/fleet.ts";
import { view } from "./tools/fixtures/tool-harness.ts";

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({ id, name: id, parentRunId: "root", depth: 1, ...overrides });

const makeFleet = (
  initial: ReadonlyArray<SubagentRunView>,
  options: {
    readonly height?: number;
    readonly matchesKeybinding?: (data: string, id: FleetKeybindingId) => boolean;
    readonly visibilityRootId?: string;
  } = {},
) => {
  let runs = initial;
  let height = options.height ?? 12;
  const actions: FleetActions = {
    stop: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    message: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
  };
  const close = vi.fn();
  const component = new SubagentFleetComponent({
    theme: plainTheme,
    getProjection: () => ({ revision: 1, runs }),
    getHeight: () => height,
    getNow: () => 1_000,
    matchesKeybinding: options.matchesKeybinding,
    visibilityRootId: options.visibilityRootId,
    requestRender: () => {},
    close,
    actions,
  });
  return {
    component,
    setHeight: (next: number) => {
      height = next;
    },
    actions,
    close,
    setRuns: (next: ReadonlyArray<SubagentRunView>) => {
      runs = next;
    },
  };
};

it("keeps the selected row reachable through live shrinking and growing", () => {
  const fixture = makeFleet(
    Array.from({ length: 40 }, (_, index) => run(`item-${index}`)),
    { height: 32 },
  );
  fixture.component.render(128);
  fixture.component.handleInput("G");
  for (const [width, height] of [
    [80, 16],
    [128, 32],
    [100, 24],
  ]) {
    fixture.setHeight(height!);
    fixture.component.invalidate();
    const lines = fixture.component.render(width!);
    expect(lines.length).toBeLessThanOrEqual(height!);
    expect(lines.join("\n")).toContain("item-39");
  }
  fixture.component.handleInput("x");
  fixture.component.handleInput("x");
  expect(fixture.actions.stop).toHaveBeenCalledWith("item-39");
  expect(fixture.close).not.toHaveBeenCalled();
});

const ESC = "\x1b";
const ENTER = "\r";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

describe("/subagents selection identity", () => {
  it("keeps the stop target pinned to the selected identity across reorder", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    component.handleInput("j");
    setRuns([run("beta"), run("alpha")]);
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledWith("beta");
  });

  it("targets a selected descendant rather than its rendered parent", () => {
    const { component, actions } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
    ]);
    component.handleInput("j");
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).toHaveBeenCalledWith("beta");
  });
});

describe("/subagents tree navigation", () => {
  it("renders descendants in one parent-before-child hierarchy by default", () => {
    const { component } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
      run("gamma"),
    ]);
    const rendered = component.render(120).join("\n");
    expect(rendered.indexOf("alpha")).toBeLessThan(rendered.indexOf("beta"));
    expect(rendered.indexOf("beta")).toBeLessThan(rendered.indexOf("gamma"));
  });

  it("collapses and expands the selected subtree with Left and Right", () => {
    const { component } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
      run("gamma", { parentRunId: "beta", depth: 3 }),
    ]);
    expect(component.render(120).join("\n")).toContain("gamma");

    component.handleInput(LEFT);
    expect(component.render(120).join("\n")).not.toContain("beta");
    component.handleInput(RIGHT);
    expect(component.render(120).join("\n")).toContain("gamma");
  });

  it.each(["h", LEFT])(
    "keeps the fixed tree key %j authoritative over configured selection bindings",
    (treeKey) => {
      const { component } = makeFleet(
        [run("alpha"), run("beta", { parentRunId: "alpha", depth: 2 })],
        { matchesKeybinding: (data, id) => data === treeKey && id === "tui.select.down" },
      );
      component.handleInput(treeKey);
      expect(component.render(120).join("\n")).not.toContain("beta");
    },
  );

  it.each(["l", ENTER])("uses h as shared pane navigation after entering detail with %j", (key) => {
    const { component, close } = makeFleet([run("alpha")]);
    component.render(120);
    component.handleInput(key);
    component.handleInput("h");
    component.handleInput(ESC);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([50, 80, 120])(
    "uses Enter for inspection and Esc returns to the tree before closing at width %i",
    (width) => {
      const { component, close } = makeFleet([
        run("alpha"),
        run("beta", { parentRunId: "alpha", depth: 2 }),
      ]);
      component.render(width);
      component.handleInput(ENTER);
      component.handleInput(ESC);
      expect(close).not.toHaveBeenCalled();
      expect(component.render(width).join("\n")).toContain("beta");

      component.handleInput(ESC);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("renders only descendants of a nested visibility root", () => {
    const { component } = makeFleet(
      [
        run("alpha"),
        run("beta", { parentRunId: "alpha", depth: 2 }),
        run("gamma", { parentRunId: "beta", depth: 3 }),
        run("outside"),
      ],
      { visibilityRootId: "alpha" },
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");
    expect(rendered).not.toContain("alpha");
    expect(rendered).not.toContain("outside");
  });

  it("never renders the authenticated visibility root when malformed ancestry cycles to it", () => {
    const { component } = makeFleet(
      [run("alpha", { parentRunId: "beta" }), run("beta", { parentRunId: "alpha", depth: 2 })],
      { visibilityRootId: "alpha" },
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("beta");
    expect(rendered).not.toContain("alpha");
  });
});

describe("/subagents stop confirmation", () => {
  it("accepts Enter and ignores unrelated input while confirmation is pending", () => {
    const { component, actions } = makeFleet([run("alpha")]);
    component.handleInput("x");
    component.handleInput("z");
    component.handleInput(ENTER);
    expect(actions.stop).toHaveBeenCalledWith("alpha");
  });
});

describe("/subagents pending state on identity change", () => {
  it("never stops a stale selection after the projection replaces the selected run", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    component.handleInput("x");
    setRuns([run("beta")]);
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it("drops an open prompt when the selected run identity changes", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha")]);
    component.handleInput("m");
    setRuns([run("other")]);
    component.handleInput(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
  });

  it("still submits a prompt for a stable selection", () => {
    const { component, actions } = makeFleet([run("alpha")]);
    component.handleInput("m");
    component.handleInput("h");
    component.handleInput("i");
    component.handleInput(ENTER);
    expect(actions.message).toHaveBeenCalledTimes(1);
    expect(actions.message).toHaveBeenCalledWith("alpha", "guidance", "hi");
  });
});
