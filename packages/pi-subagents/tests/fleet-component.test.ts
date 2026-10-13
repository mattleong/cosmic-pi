import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import { STEERING_DELIVERY_STATES, type SubagentRunView } from "../src/run/model.ts";
import { steeringDeliveryEvidence } from "../src/tools/outcome.ts";
import {
  SubagentFleetComponent,
  type FleetActions,
  type FleetMessageDelivery,
} from "../src/ui/fleet.ts";
import { view } from "./fixtures/run-view.ts";

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({ id, name: id, parentRunId: "root", depth: 1, ...overrides });

const makeFleet = (
  initial: ReadonlyArray<SubagentRunView>,
  options: {
    readonly height?: number;
    readonly matchesKeybinding?: (data: string, id: FullScreenSelectionKeybindingId) => boolean;
    readonly visibilityRootId?: string;
    readonly isCurrent?: () => boolean;
  } = {},
) => {
  let runs = initial;
  let height = options.height ?? 12;
  const actions: FleetActions = {
    stop: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    message: vi.fn((): Promise<FleetMessageDelivery> => Promise.resolve("delivered")),
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
    isCurrent: options.isCurrent,
    requestRender: () => {},
    close,
    actions,
  });
  return {
    component,
    press: (...keys: ReadonlyArray<string>) => {
      for (const key of keys) component.handleInput(key);
    },
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
  fixture.press("x", "x");
  expect(fixture.actions.stop).toHaveBeenCalledWith(
    "item-39",
    expect.objectContaining({ assignmentEpoch: 1 }),
  );
  expect(fixture.close).not.toHaveBeenCalled();
});

const ESC = "\x1b";
const ENTER = "\r";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

describe("/subagents selection identity", () => {
  it("keeps the stop target pinned to the selected identity across reorder", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    press("j");
    setRuns([run("beta"), run("alpha")]);
    press("x", "x");
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });

  it("targets a selected descendant rather than its rendered parent", () => {
    const { press, actions } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
    ]);
    press("j", "x", "x");
    expect(actions.stop).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });
});

describe("/subagents lifecycle confirmations", () => {
  it("interrupts only after the same key confirms it, and cancels on Esc", () => {
    const running = run("alpha", { state: "running", capabilities: ["interrupt"] });
    const { component, press, actions } = makeFleet([running]);
    component.render(100);
    press("i");
    expect(actions.interrupt).not.toHaveBeenCalled();
    press(ESC, "i", "i");
    expect(actions.interrupt).toHaveBeenCalledTimes(1);
    expect(actions.interrupt).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
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
    const { component, press, close } = makeFleet([run("alpha")]);
    component.render(120);
    press(key, "h", ESC);
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
});

describe("/subagents stop confirmation", () => {
  it("accepts Enter and ignores unrelated input while confirmation is pending", () => {
    const { press, actions } = makeFleet([run("alpha")]);
    press("x", "z", ENTER);
    expect(actions.stop).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });
});

describe("/subagents pending state on identity change", () => {
  it("rejects a reply when a later question replaces the question being answered", () => {
    const before = run("alpha", {
      state: "waiting_for_parent",
      question: { requestId: "first", message: "Proceed?" },
    });
    const { press, actions, setRuns } = makeFleet([before]);
    press("m", "y", "e", "s");
    setRuns([{ ...before, question: { requestId: "second", message: "Proceed?" } }]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
    press(ESC, "m", "n", "o", ENTER);
    expect(actions.message).toHaveBeenCalledWith(
      "alpha",
      "reply",
      "no",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });

  it("rejects guidance captured before an assignment rollover", () => {
    const before = run("alpha");
    const { press, actions, setRuns } = makeFleet([before]);
    press("m", "h", "i");
    setRuns([{ ...before, assignmentEpoch: before.assignmentEpoch + 1 }]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
  });

  it("requires a new stop confirmation after an assignment rollover", () => {
    const before = run("alpha");
    const { press, actions, setRuns } = makeFleet([before]);
    press("x");
    setRuns([{ ...before, assignmentEpoch: before.assignmentEpoch + 1 }]);
    press(ENTER);
    expect(actions.stop).not.toHaveBeenCalled();
    press("x", ENTER);
    expect(actions.stop).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ assignmentEpoch: 2 }),
    );
  });

  it("refuses retained controls after the fleet has been disposed", () => {
    const { press, actions, component } = makeFleet([run("alpha")]);
    press("m", "h", "i");
    component.dispose();
    press(ENTER, "x", ENTER);
    expect(actions.message).not.toHaveBeenCalled();
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it("closes a replaced activation before a pending action can execute", () => {
    let current = true;
    const { press, actions, close } = makeFleet([run("alpha")], { isCurrent: () => current });
    press("x");
    current = false;
    press(ENTER);
    expect(actions.stop).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("never stops a stale selection after the projection replaces the selected run", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    press("x");
    setRuns([run("beta")]);
    press("x");
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it("drops an open prompt when the selected run identity changes", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha")]);
    press("m");
    setRuns([run("other")]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
  });

  it("still submits a prompt for a stable selection", () => {
    const { press, actions } = makeFleet([run("alpha")]);
    press("m", "h", "i", ENTER);
    expect(actions.message).toHaveBeenCalledTimes(1);
    expect(actions.message).toHaveBeenCalledWith(
      "alpha",
      "guidance",
      "hi",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });
});

const question = { requestId: "q", message: "Which file?" };

describe("/subagents unresolved guidance delivery", () => {
  for (const steeringDelivery of ["pending", "unresolved"] as const) {
    it(`blocks new guidance and interruption while delivery is ${steeringDelivery}`, () => {
      const { press, actions } = makeFleet([run("alpha", { steeringDelivery })]);
      press("m", "z", "z", ENTER, "h", "i");
      expect(actions.message).not.toHaveBeenCalled();
      expect(actions.interrupt).not.toHaveBeenCalled();

      press("x", "x");
      expect(actions.stop).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ assignmentEpoch: 1 }),
      );
    });

    it(`keeps a parent-question reply available while delivery is ${steeringDelivery}`, () => {
      const { press, actions } = makeFleet([
        run("alpha", { state: "waiting_for_parent", question, steeringDelivery }),
      ]);
      press("m", "o", "k", ENTER);
      expect(actions.message).toHaveBeenCalledWith(
        "alpha",
        "reply",
        "ok",
        expect.objectContaining({ assignmentEpoch: 1 }),
      );
    });
  }

  for (const steeringDelivery of ["confirmed", "not-sent", "report-unconfirmed"] as const)
    it(`allows guidance after ${steeringDelivery} delivery`, () => {
      const { press, actions } = makeFleet([run("alpha", { steeringDelivery })]);
      press("m", "o", "k", ENTER);
      expect(actions.message).toHaveBeenCalledWith(
        "alpha",
        "guidance",
        "ok",
        expect.objectContaining({ assignmentEpoch: 1 }),
      );
    });

  it("never sends a guidance prompt opened before delivery became pending", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha")]);
    press("m", "h", "i");
    setRuns([run("alpha", { steeringDelivery: "pending" })]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();

    setRuns([run("alpha", { steeringDelivery: "confirmed" })]);
    press(ENTER);
    expect(actions.message).toHaveBeenCalledTimes(1);
    expect(actions.message).toHaveBeenCalledWith(
      "alpha",
      "guidance",
      "hi",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });

  it("never sends a stale guidance prompt as a reply after the run starts waiting", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha")]);
    press("m", "h", "i");
    setRuns([run("alpha", { state: "waiting_for_parent", question })]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
  });

  it("shows each guidance delivery state from the shared evidence in the detail pane", () => {
    const { component, setRuns } = makeFleet([run("alpha")], { height: 30 });
    const withoutDelivery = component.render(200).join("\n");
    for (const state of STEERING_DELIVERY_STATES) {
      expect(withoutDelivery).not.toContain(steeringDeliveryEvidence[state].message);
      setRuns([run("alpha", { steeringDelivery: state })]);
      expect(component.render(200).join("\n")).toContain(steeringDeliveryEvidence[state].message);
    }
  });
});
