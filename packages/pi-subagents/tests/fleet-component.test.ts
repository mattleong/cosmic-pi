// Behavior-first component tests for the /subagents fleet: expandable hierarchy,
// selection identity across reorder, Esc detail → list → close, and pending action/prompt
// clearing on identity change. Assertions use transitions and callbacks, not exact chrome.
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import { STEERING_DELIVERY_STATES, type SubagentRunView } from "../src/run/model.ts";
import { steeringDeliveryEvidence } from "../src/tools/outcome.ts";
import {
  SubagentFleetComponent,
  type FleetActions,
  type FleetKeybindingId,
  type FleetMessageDelivery,
  type FleetNoticeKind,
} from "../src/ui/fleet.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { view } from "./tools/fixtures/tool-harness.ts";

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({ id, name: id, parentRunId: "root", depth: 1, ...overrides });

const makeFleet = (
  initial: ReadonlyArray<SubagentRunView>,
  options: {
    readonly height?: number;
    readonly matchesKeybinding?: (data: string, id: FleetKeybindingId) => boolean;
    readonly visibilityRootId?: string;
    readonly message?: FleetActions["message"];
  } = {},
) => {
  let runs = initial;
  let height = options.height ?? 12;
  const actions: FleetActions = {
    stop: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    message: vi.fn(
      options.message ?? ((): Promise<FleetMessageDelivery> => Promise.resolve("delivered")),
    ),
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

describe("/subagents lifecycle confirmations", () => {
  it("interrupts only after the same key confirms it, and cancels on Esc", () => {
    const running = run("alpha", { state: "running", capabilities: ["interrupt"] });
    const { component, actions } = makeFleet([running]);
    component.render(100);
    component.handleInput("i");
    expect(actions.interrupt).not.toHaveBeenCalled();
    component.handleInput(ESC);
    component.handleInput("i");
    component.handleInput("i");
    expect(actions.interrupt).toHaveBeenCalledTimes(1);
    expect(actions.interrupt).toHaveBeenCalledWith("alpha");
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

const press = (component: SubagentFleetComponent, ...keys: string[]) => {
  for (const key of keys) component.handleInput(key);
};

/** Waits until the one in-flight action leaves its progress notice. */
const settledNotice = (component: SubagentFleetComponent) =>
  step(() =>
    vi.waitFor(() => {
      expect(component.noticeKind).toBeDefined();
      expect(component.noticeKind).not.toBe("info");
    }),
  ).pipe(Effect.map(() => component.noticeKind));

const question = { requestId: "q", message: "Which file?", createdAt: 1 };

describe("/subagents message outcomes", () => {
  const outcomes: ReadonlyArray<
    readonly [string, () => Promise<FleetMessageDelivery>, FleetNoticeKind]
  > = [
    ["delivered guidance as success", () => Promise.resolve("delivered"), "success"],
    [
      "pending guidance as neither success nor failure",
      () => Promise.resolve("pending"),
      "warning",
    ],
    ["a rejected message as an error", () => Promise.reject(new Error("rejected")), "error"],
  ];
  for (const [label, message, expected] of outcomes)
    effectTest(`shows ${label}`, function* () {
      const { component, actions } = makeFleet([run("alpha")], { message });
      press(component, "m", "h", "i", ENTER);
      expect(yield* settledNotice(component)).toBe(expected);
      expect(actions.message).toHaveBeenCalledTimes(1);
    });

  effectTest("keeps reply and next-assignment success distinct from guidance", function* () {
    const replying = makeFleet([run("alpha", { state: "waiting_for_parent", question })]);
    press(replying.component, "m", "o", "k", ENTER);
    expect(yield* settledNotice(replying.component)).toBe("success");
    expect(replying.actions.message).toHaveBeenCalledWith("alpha", "reply", "ok");

    const next = makeFleet([run("alpha", { state: "reported", closeOnReport: false })]);
    press(next.component, "m", "o", "k", ENTER);
    expect(yield* settledNotice(next.component)).toBe("success");
    expect(next.actions.message).toHaveBeenCalledWith("alpha", "next-assignment", "ok");
  });
});

describe("/subagents unresolved guidance delivery", () => {
  for (const steeringDelivery of ["pending", "unresolved"] as const) {
    it(`blocks new guidance and interruption while delivery is ${steeringDelivery}`, () => {
      const { component, actions } = makeFleet([run("alpha", { steeringDelivery })]);
      // Without a prompt, the printable keys are ignored and Enter only inspects the run.
      press(component, "m", "z", "z", ENTER, "h", "i");
      expect(actions.message).not.toHaveBeenCalled();
      expect(actions.interrupt).not.toHaveBeenCalled();

      press(component, "x", "x");
      expect(actions.stop).toHaveBeenCalledWith("alpha");
    });

    it(`blocks a retained next assignment while delivery is ${steeringDelivery}`, () => {
      const { component, actions } = makeFleet([
        run("alpha", { state: "reported", closeOnReport: false, steeringDelivery }),
      ]);
      press(component, "m", "z", "z", ENTER);
      expect(actions.message).not.toHaveBeenCalled();
    });

    it(`keeps a parent-question reply available while delivery is ${steeringDelivery}`, () => {
      const { component, actions } = makeFleet([
        run("alpha", { state: "waiting_for_parent", question, steeringDelivery }),
      ]);
      press(component, "m", "o", "k", ENTER);
      expect(actions.message).toHaveBeenCalledWith("alpha", "reply", "ok");
    });
  }

  for (const steeringDelivery of ["confirmed", "not-sent", "report-unconfirmed"] as const)
    it(`allows guidance after ${steeringDelivery} delivery`, () => {
      const { component, actions } = makeFleet([run("alpha", { steeringDelivery })]);
      press(component, "m", "o", "k", ENTER);
      expect(actions.message).toHaveBeenCalledWith("alpha", "guidance", "ok");
    });

  it("never sends a guidance prompt opened before delivery became pending", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha")]);
    press(component, "m", "h", "i");
    setRuns([run("alpha", { steeringDelivery: "pending" })]);
    press(component, ENTER);
    expect(actions.message).not.toHaveBeenCalled();

    // The typed prompt survives, so a later settled state can still send it exactly once.
    setRuns([run("alpha", { steeringDelivery: "confirmed" })]);
    press(component, ENTER);
    expect(actions.message).toHaveBeenCalledTimes(1);
    expect(actions.message).toHaveBeenCalledWith("alpha", "guidance", "hi");
  });

  it("never sends a stale guidance prompt as a reply after the run starts waiting", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha")]);
    press(component, "m", "h", "i");
    setRuns([run("alpha", { state: "waiting_for_parent", question })]);
    press(component, ENTER);
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
