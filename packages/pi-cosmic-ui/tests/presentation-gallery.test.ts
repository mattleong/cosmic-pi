import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer, stripTerminalControls } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { ActivityComponent } from "../src/activity/component.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityWidgetHeight } from "../src/activity/widget-projection.ts";
import { isFinished, type ActivityRow } from "../src/activity/model.ts";
import { activityRow, memberRow, workflowRow } from "./support/activity.ts";

const directory = Effect.runSync(
  Config.String("PRESENTATION_GALLERY").pipe(Config.withDefault("")),
);
const stop = {
  id: "stop",
  label: "Stop workflow",
  confirmation: "Stop this workflow and its running agents?",
};
const skip = [{ id: "skip", label: "Skip" }];
const standalone = [
  activityRow("docs", "running", undefined, {
    title: "Update documentation",
    profile: "worker",
    startedAt: 0,
  }),
  activityRow("server", "running", undefined, {
    title: "Development server",
    kind: "command",
    startedAt: 0,
  }),
];
const review = workflowRow("review", ["Find", "Review", "Verify"], "running", "Review", {
  title: "Review authentication",
  summary: "Found 5 call sites; reviewing each one for token reuse",
  detail: 'Args: { "scope": "src/auth" }\nfound 4 risky call sites',
  startedAt: 0,
  actions: [stop],
});
const found = memberRow("finder", review, "Find", "done", {
  title: "Find call sites",
  profile: "scout",
  startedAt: 0,
  endedAt: 30_000,
});
const reviewers = ["Session handling", "Token refresh"].map((title, index) =>
  memberRow(`reviewer-${index}`, review, "Review", "running", {
    title,
    profile: "reviewer",
    startedAt: 35_000,
    actions: [{ id: "stop", label: "Stop" }],
  }),
);
const queued = ["Password reset", "OAuth callback", "Rate limits"].map((title, index) =>
  memberRow(`queued-${index}`, review, "Review", "pending", {
    title,
    profile: "reviewer",
    actions: skip,
  }),
);
const running: readonly ActivityRow[] = [review, found, ...reviewers, ...queued];
const stopped = workflowRow("stopped", ["Plan", "Implement", "Verify"], "cancelled", "Implement", {
  title: "Migrate settings store",
  startedAt: 0,
  endedAt: 70_000,
});
const stoppedRows: readonly ActivityRow[] = [
  stopped,
  memberRow("planner", stopped, "Plan", "done", {
    title: "Draft migration plan",
    profile: "planner",
    startedAt: 0,
    endedAt: 20_000,
  }),
  memberRow("implementer", stopped, "Implement", "cancelled", {
    title: "Rewrite store",
    profile: "worker",
    startedAt: 25_000,
    endedAt: 70_000,
  }),
  memberRow("queued-verify", stopped, "Implement", "cancelled", {
    title: "Port callers",
    profile: "worker",
  }),
];
const early = workflowRow("early", ["Triage", "Fix", "Verify"], "done", "Triage", {
  title: "Fix flaky test",
  summary: "returned early: nothing to fix",
  startedAt: 0,
  endedAt: 40_000,
});
const earlyRows: readonly ActivityRow[] = [
  early,
  memberRow("triage", early, "Triage", "done", {
    title: "Reproduce failure",
    profile: "scout",
    startedAt: 0,
    endedAt: 38_000,
  }),
];
const failing = workflowRow("failing", ["Build", "Test"], "running", "Test", {
  title: "Release candidate",
  startedAt: 0,
  actions: [stop],
});
const failingRows: readonly ActivityRow[] = [
  failing,
  memberRow("build", failing, "Build", "done", {
    title: "Build packages",
    profile: "worker",
    startedAt: 0,
    endedAt: 50_000,
  }),
  memberRow("unit", failing, "Test", "failed", {
    title: "Unit tests",
    profile: "worker",
    summary: "3 assertions failed in session.test.ts",
    startedAt: 52_000,
    endedAt: 80_000,
  }),
  memberRow("e2e", failing, "Test", "running", {
    title: "End-to-end tests",
    profile: "worker",
    startedAt: 52_000,
  }),
];
/** The user stopped the run during its second phase; producer counts cover evicted members. */
const halted = workflowRow("halted", [], "cancelled", "Implement", {
  title: "Migrate settings store",
  startedAt: 0,
  endedAt: 70_000,
  phases: [
    { title: "Plan", work: { items: 2, finished: 2, stopped: 0 } },
    { title: "Implement", work: { items: 3, finished: 3, stopped: 3 } },
    { title: "Verify" },
  ],
});
const haltedRows: readonly ActivityRow[] = [
  halted,
  memberRow("halted-plan", halted, "Plan", "done", {
    title: "Draft migration plan",
    profile: "planner",
    startedAt: 0,
    endedAt: 20_000,
  }),
  memberRow("halted-rewrite", halted, "Implement", "cancelled", {
    title: "Rewrite store",
    profile: "worker",
    startedAt: 25_000,
    endedAt: 70_000,
  }),
];
const flaky = workflowRow("flaky", ["Build", "Test", "Report"], "running", "Test", {
  title: "Nightly regression sweep",
  summary: "Retrying failed suites once before reporting",
  startedAt: 0,
  actions: [stop],
});
const flakyRows: readonly ActivityRow[] = [
  flaky,
  memberRow("flaky-build", flaky, "Build", "done", {
    title: "Build packages",
    profile: "worker",
    startedAt: 0,
    endedAt: 20_000,
  }),
  ...["auth", "billing", "search", "mail"].map((suite, index) =>
    memberRow(`flaky-${suite}`, flaky, "Test", "failed", {
      title: `${suite} suite`,
      profile: "worker",
      summary: `${index + 2} tests failed; first: ${suite} handles expired sessions`,
      startedAt: 22_000,
      endedAt: 40_000 + index * 5_000,
    }),
  ),
  memberRow("flaky-media", flaky, "Test", "running", {
    title: "media suite",
    profile: "worker",
    startedAt: 22_000,
  }),
];
/** Failures past the cap in two phases, one of which has none of the latest failures. */
const spread = workflowRow("spread", ["Lint", "Build", "Test"], "running", "Test", {
  title: "Monorepo health check",
  startedAt: 0,
  actions: [stop],
});
const spreadFailure = (phase: string, name: string, endedAt: number): ActivityRow =>
  memberRow(`spread-${name}`, spread, phase, "failed", {
    title: `${name} check`,
    profile: "worker",
    summary: `${name} reported errors`,
    startedAt: 1_000,
    endedAt,
  });
const spreadRows: readonly ActivityRow[] = [
  spread,
  spreadFailure("Lint", "eslint", 8_000),
  spreadFailure("Lint", "oxlint", 6_000),
  spreadFailure("Build", "types", 30_000),
  spreadFailure("Test", "unit", 70_000),
  spreadFailure("Test", "e2e", 60_000),
  spreadFailure("Test", "smoke", 50_000),
  memberRow("spread-integration", spread, "Test", "running", {
    title: "integration check",
    profile: "worker",
    startedAt: 40_000,
  }),
];
/** The producer counts a failure whose member row it no longer publishes. */
const counted = workflowRow("counted", [], "running", "Verify", {
  title: "Release candidate",
  startedAt: 0,
  actions: [stop],
  phases: [
    { title: "Build", work: { items: 4, finished: 4, stopped: 0, failed: 1 } },
    { title: "Verify", work: { items: 1, finished: 0, stopped: 0 } },
  ],
});
const countedRows: readonly ActivityRow[] = [
  counted,
  memberRow("counted-verify", counted, "Verify", "running", {
    title: "Smoke test the release",
    profile: "worker",
    startedAt: 60_000,
  }),
];
const lengthy = workflowRow("lengthy", ["Inventory", "Migrate", "Verify"], "running", "Migrate", {
  title: "Migrate every billing service to the consolidated settings schema",
  startedAt: 0,
  actions: [stop],
});
const lengthyRows: readonly ActivityRow[] = [
  lengthy,
  memberRow("lengthy-inventory", lengthy, "Inventory", "done", {
    title: "Inventory billing services",
    profile: "scout",
    startedAt: 0,
    endedAt: 30_000,
  }),
  memberRow("lengthy-invoices", lengthy, "Migrate", "failed", {
    title: "Migrate invoices",
    profile: "worker",
    summary: "Schema check rejected the legacy currency field",
    startedAt: 32_000,
    endedAt: 60_000,
  }),
  memberRow("lengthy-refunds", lengthy, "Migrate", "running", {
    title: "Migrate refunds",
    profile: "worker",
    startedAt: 32_000,
  }),
];
const loose = workflowRow("loose", [], "running", undefined, {
  title: "Ad-hoc fan-out",
  startedAt: 0,
  actions: [stop],
});
const asking = memberRow("asking", loose, undefined, "needs-input", {
  title: "Choose a library",
  profile: "researcher",
  startedAt: 10_000,
  inputTarget: "parent",
});
const looseRows: readonly ActivityRow[] = [
  loose,
  asking,
  memberRow("loose-worker", loose, undefined, "running", {
    title: "Benchmark options",
    profile: "worker",
    startedAt: 10_000,
  }),
  activityRow("human", "needs-input", asking.id, {
    kind: "question",
    title: "Approve the dependency",
  }),
];
/** Declared agents the script hasn't called; finished workflows never ran them. */
const plannedRow = (
  id: string,
  workflow: ActivityRow,
  phase: string,
  title: string,
  profile: string,
): ActivityRow =>
  memberRow(id, workflow, phase, isFinished(workflow) ? "cancelled" : "pending", {
    title,
    profile,
    planned: true,
  });
const plan = workflowRow("plan", ["Map", "Review", "Verify"], "running", "Map", {
  title: "Audit payment flows",
  summary: "Mapping checkout, refunds and payouts",
  startedAt: 0,
  actions: [stop],
});
const planRows: readonly ActivityRow[] = [
  plan,
  memberRow("mapper", plan, "Map", "running", {
    title: "Map payment entry points",
    profile: "scout",
    startedAt: 10_000,
  }),
  plannedRow("plan-checkout", plan, "Review", "review:checkout", "reviewer"),
  plannedRow("plan-refunds", plan, "Review", "review:refunds", "reviewer"),
  plannedRow("plan-payouts", plan, "Review", "review:payouts", "reviewer"),
  plannedRow("plan-verify", plan, "Verify", "Verify findings", "reviewer"),
];
const claimed = workflowRow("claimed", ["Map", "Review", "Verify"], "running", "Review", {
  title: "Audit payment flows",
  summary: "review:refunds is waiting for a free agent slot",
  startedAt: 0,
  actions: [stop],
  phases: [{ title: "Map" }, { title: "Review" }, { title: "Verify", planned: 1 }],
});
const claimedRows: readonly ActivityRow[] = [
  claimed,
  memberRow("claimed-map", claimed, "Map", "done", {
    title: "Map payment entry points",
    profile: "scout",
    startedAt: 10_000,
    endedAt: 40_000,
  }),
  memberRow("claimed-checkout", claimed, "Review", "running", {
    title: "review:checkout",
    profile: "reviewer",
    startedAt: 45_000,
  }),
  memberRow("claimed-refunds", claimed, "Review", "pending", {
    title: "review:refunds",
    profile: "reviewer",
    actions: skip,
  }),
  plannedRow("claimed-payouts", claimed, "Review", "review:payouts", "reviewer"),
  plannedRow("claimed-verify", claimed, "Verify", "Verify findings", "reviewer"),
];
const unrun = workflowRow("unrun", ["Map", "Review", "Verify"], "done", "Review", {
  title: "Audit payment flows",
  summary: "Returned early: no payment code changed",
  startedAt: 0,
  endedAt: 50_000,
});
const unrunRows: readonly ActivityRow[] = [
  unrun,
  memberRow("unrun-map", unrun, "Map", "done", {
    title: "Map payment entry points",
    profile: "scout",
    startedAt: 0,
    endedAt: 30_000,
  }),
  memberRow("unrun-checkout", unrun, "Review", "done", {
    title: "review:checkout",
    profile: "reviewer",
    startedAt: 32_000,
    endedAt: 50_000,
  }),
  plannedRow("unrun-refunds", unrun, "Review", "review:refunds", "reviewer"),
  plannedRow("unrun-verify", unrun, "Verify", "Verify findings", "reviewer"),
];
const crowded = workflowRow(
  "crowded",
  ["Inventory", "Audit", "Fix", "Verify"],
  "running",
  "Inventory",
  {
    title: "Harden every service",
    summary: "Listing services under services/",
    startedAt: 0,
    actions: [stop],
  },
);
const crowdedRows: readonly ActivityRow[] = [
  crowded,
  memberRow("inventory", crowded, "Inventory", "running", {
    title: "Inventory services",
    profile: "scout",
    startedAt: 5_000,
  }),
  ...["Audit", "Fix", "Verify"].flatMap((phase) =>
    ["billing", "accounts", "search", "mail", "media"].map((service) =>
      plannedRow(
        `${phase}-${service}`,
        crowded,
        phase,
        `${phase.toLowerCase()}:${service}`,
        "worker",
      ),
    ),
  ),
];
const passed = workflowRow("passed", ["Map", "Review", "Verify"], "running", "Verify", {
  title: "Audit payment flows",
  summary: "Verifying review findings",
  startedAt: 0,
  actions: [stop],
  phases: [{ title: "Map", planned: 1 }, { title: "Review" }, { title: "Verify" }],
  // Planned agents in phases past the ones Activity shows.
  unphasedPlanned: 12,
});
const passedRows: readonly ActivityRow[] = [
  passed,
  plannedRow("passed-map", passed, "Map", "Map payout entry points", "scout"),
  memberRow("passed-review", passed, "Review", "done", {
    title: "review:checkout",
    profile: "reviewer",
    startedAt: 10_000,
    endedAt: 40_000,
  }),
  memberRow("passed-verify", passed, "Verify", "running", {
    title: "Verify findings",
    profile: "reviewer",
    startedAt: 45_000,
  }),
];
const scenarios: ReadonlyArray<{
  readonly title: string;
  readonly rows: readonly ActivityRow[];
  /** Also render the stacked manager tier and the compact widget used beside an input dock. */
  readonly tiers?: boolean;
}> = [
  { title: "Later phases show the agents a workflow plans to call", rows: planRows },
  { title: "Partly claimed plan with a narrator line", rows: claimedRows },
  { title: "Finished workflow with planned agents it never ran", rows: unrunRows },
  { title: "Planned agents that don't fit are counted on their phase", rows: crowdedRows },
  {
    title: "A passed phase with planned agents, and planned agents in phases not shown",
    rows: passedRows,
  },
  { title: "Running workflow with queued placeholders that can be skipped", rows: running },
  {
    title: "Running workflow beside standalone agents and tasks",
    rows: [...running, ...standalone],
  },
  { title: "Stopped workflow", rows: stoppedRows },
  {
    title: "A workflow stopped in its second phase counts only the first as done",
    rows: haltedRows,
    tiers: true,
  },
  { title: "Skipped phases after an early return", rows: earlyRows },
  { title: "Failed member in a live phase", rows: failingRows },
  { title: "Failures past the cap in a live workflow", rows: flakyRows, tiers: true },
  { title: "Failures past the cap counted within each phase", rows: spreadRows, tiers: true },
  { title: "A phase whose producer counts a failure it no longer shows", rows: countedRows },
  {
    title: "A long workflow name beside attention and phase counts",
    rows: lengthyRows,
    tiers: true,
  },
  { title: "Workflow members without phases and an owned question", rows: looseRows },
  {
    title: "Clipped workflows retain attention and hidden evidence",
    rows: [...running, ...failingRows, ...looseRows, ...stoppedRows, ...standalone],
  },
  {
    title: "Standalone queued and urgent questions",
    rows: [
      activityRow("queued", "pending", undefined, { kind: "question" }),
      activityRow("urgent", "needs-input", undefined, { kind: "question" }),
    ],
  },
];

const managerFrames = (rows: readonly ActivityRow[], tiers: boolean) => {
  const component = new ActivityComponent({
    snapshot: () => rows,
    theme: plainTheme,
    height: () => 24,
    now: () => 90_000,
    close: () => undefined,
    invoke: () => undefined,
    requestRender: () => undefined,
  });
  const frames: Array<readonly [string, readonly string[]]> = [
    ["manager · 140 cols", component.render(140)],
  ];
  if (tiers) frames.push(["stacked manager · 80 cols", component.render(80)]);
  if (!rows.some((row) => row.kind === "workflow")) return frames;
  component.handleInput("\r");
  frames.push(["inspect workflow", component.render(140)]);
  component.handleInput("h");
  component.handleInput("j");
  component.handleInput("\r");
  frames.push(["inspect first child", component.render(140)]);
  component.handleInput("h");
  const queued = rows.find(
    (row) => row.status === "pending" && row.startedAt === undefined && row.planned !== true,
  );
  for (let step = 0; queued && step < 12; step++) {
    if (component.shell.state.selectedId === queued.key) {
      component.handleInput("\r");
      frames.push(["inspect queued placeholder", component.render(140)]);
      component.handleInput("h");
      break;
    }
    component.handleInput("j");
  }
  component.handleInput("g");
  component.handleInput("g");
  const planned = rows.find((row) => row.planned === true);
  for (let step = 0; planned && step < 16; step++) {
    if (component.shell.state.selectedId === planned.key) {
      component.handleInput("\r");
      frames.push(["inspect planned agent", component.render(140)]);
      component.handleInput("h");
      break;
    }
    component.handleInput("j");
  }
  component.handleInput("g");
  component.handleInput("g");
  component.handleInput("j");
  component.handleInput("h");
  frames.push(["collapsed manager · 100 cols", component.render(100)]);
  if (tiers) frames.push(["collapsed stacked manager · 80 cols", component.render(80)]);
  return frames;
};

const steered = activityRow("steered", "running", undefined, {
  title: "Refactor billing client",
  profile: "worker",
  startedAt: 0,
  actions: [
    { id: "stop", label: "Stop" },
    { id: "interrupt", label: "Interrupt" },
    { id: "message", label: "Message" },
    { id: "rename", label: "Rename" },
  ],
});
const crowdedActions = activityRow("crowded-actions", "running", undefined, {
  title: "Custom producer",
  startedAt: 0,
  actions: Array.from({ length: 11 }, (_, index) => ({
    id: `custom-${index + 1}`,
    label: `Custom ${index + 1}`,
  })),
});
/** Footers only, at each width tier, with the default keys and then the full help. */
const footerScenarios: ReadonlyArray<readonly [string, readonly ActivityRow[], string]> = [
  ["One stop action", running, review.key],
  ["One skip action", running, queued[0]!.key],
  ["Several direct actions", [steered], steered.key],
  ["More actions than one page", [crowdedActions], crowdedActions.key],
  ["No actions", stoppedRows, stopped.key],
];
const footerFrames = (rows: readonly ActivityRow[], key: string) => {
  const component = new ActivityComponent({
    snapshot: () => rows,
    theme: plainTheme,
    height: () => 12,
    now: () => 90_000,
    close: () => undefined,
    invoke: () => undefined,
    requestRender: () => undefined,
  });
  component.render(140);
  for (let step = 0; step < 16 && component.shell.state.selectedId !== key; step++)
    component.handleInput("j");
  const footers = (help: string) =>
    [140, 100, 80, 50].map((width) => `${help}${width} cols ${component.render(width).at(-1)}`);
  const lines = footers("");
  component.handleInput("?");
  const help = footers("? ");
  component.handleInput("?");
  // A destructive action asks first: its question fills the body and the footer names it.
  const confirmable = rows.find((row) => row.key === key)?.actions?.[0]?.confirmation;
  if (!confirmable) return [...lines, ...help];
  component.handleInput("x");
  return [
    ...lines,
    ...help,
    ...component.render(80).map((line) => `confirm 80 cols ${line}`),
    `confirm 50 cols ${component.render(50).at(-1)}`,
  ];
};

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders grouped Activity states without source execution", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const scenario of scenarios) {
        const widgets: ReadonlyArray<readonly [string, number, number]> = [
          ...[60, 80, 100].map(
            (width) => [`${width} cols`, width, activityWidgetHeight(scenario.rows, 24)] as const,
          ),
          ...(scenario.tiers ? [["compact beside an input dock · 80 cols", 80, 3] as const] : []),
        ];
        for (const [label, width, height] of widgets)
          lines.push(
            `── ${scenario.title} · widget · ${label}`,
            ...renderActivityWidget(scenario.rows, width, height, {
              now: 90_000,
              theme: plainTheme,
            }),
            "",
          );
        for (const [label, frame] of managerFrames(scenario.rows, scenario.tiers === true))
          lines.push(`── ${scenario.title} · ${label}`, ...frame, "");
      }
      for (const [title, rows, key] of footerScenarios)
        lines.push(`── Footer · ${title}`, ...footerFrames(rows, key), "");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(directory, "pi-cosmic-ui.txt"),
        `${lines.map((line) => stripTerminalControls(line).replace(/\s+$/u, "")).join("\n")}\n`,
      );
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});
