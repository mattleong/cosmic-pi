import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { stripTerminalControls } from "pi-cosmic-core";
import {
  extensionContextFixture,
  galleryDirectory,
  plainTheme,
  writeGallerySection,
} from "pi-cosmic-core/testing";
import { makeWorkingRow } from "../src/working/row.ts";
import { ActivityComponent } from "../src/activity/component.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityWidgetHeight } from "../src/activity/widget-projection.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { activityRow, memberRow } from "./support/activity.ts";

const directory = galleryDirectory(process.env) ?? "";
const stop = {
  id: "stop",
  label: "Stop agent",
  confirmation: "Stop this agent and its subagents?",
};
const stopQueued = [{ id: "stop", label: "Stop" }];
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
const review = activityRow("review", "running", undefined, {
  title: "Review authentication",
  profile: "planner",
  summary: "Found 5 call sites; reviewing each one for token reuse",
  detail: 'Args: { "scope": "src/auth" }\nfound 4 risky call sites',
  startedAt: 0,
  actions: [stop],
});
const found = memberRow("finder", review, "done", {
  title: "Find call sites",
  profile: "scout",
  startedAt: 0,
  endedAt: 30_000,
});
const reviewers = ["Session handling", "Token refresh"].map((title, index) =>
  memberRow(`reviewer-${index}`, review, "running", {
    title,
    profile: "reviewer",
    startedAt: 35_000,
    actions: [{ id: "stop", label: "Stop" }],
  }),
);
const queued = ["Password reset", "OAuth callback", "Rate limits"].map((title, index) =>
  memberRow(`queued-${index}`, review, "pending", {
    title,
    profile: "reviewer",
    actions: stopQueued,
  }),
);
const running: readonly ActivityRow[] = [review, found, ...reviewers, ...queued];
const stopped = activityRow("stopped", "cancelled", undefined, {
  title: "Migrate settings store",
  profile: "planner",
  startedAt: 0,
  endedAt: 70_000,
});
const stoppedRows: readonly ActivityRow[] = [
  stopped,
  memberRow("planner", stopped, "done", {
    title: "Draft migration plan",
    profile: "planner",
    startedAt: 0,
    endedAt: 20_000,
  }),
  memberRow("implementer", stopped, "cancelled", {
    title: "Rewrite store",
    profile: "worker",
    startedAt: 25_000,
    endedAt: 70_000,
  }),
  memberRow("queued-verify", stopped, "cancelled", {
    title: "Port callers",
    profile: "worker",
  }),
];
const failing = activityRow("failing", "running", undefined, {
  title: "Release candidate",
  profile: "planner",
  startedAt: 0,
  actions: [stop],
});
const failingRows: readonly ActivityRow[] = [
  failing,
  memberRow("build", failing, "done", {
    title: "Build packages",
    profile: "worker",
    startedAt: 0,
    endedAt: 50_000,
  }),
  memberRow("unit", failing, "failed", {
    title: "Unit tests",
    profile: "worker",
    summary: "3 assertions failed in session.test.ts",
    startedAt: 52_000,
    endedAt: 80_000,
  }),
  memberRow("e2e", failing, "running", {
    title: "End-to-end tests",
    profile: "worker",
    startedAt: 52_000,
  }),
];
const lengthy = activityRow("lengthy", "running", undefined, {
  title: "Migrate every billing service to the consolidated settings schema",
  profile: "planner",
  startedAt: 0,
  actions: [stop],
});
const lengthyRows: readonly ActivityRow[] = [
  lengthy,
  memberRow("lengthy-inventory", lengthy, "done", {
    title: "Inventory billing services",
    profile: "scout",
    startedAt: 0,
    endedAt: 30_000,
  }),
  memberRow("lengthy-invoices", lengthy, "blocked", {
    title: "Migrate invoices",
    profile: "worker",
    blockedReason: "write-containment",
    startedAt: 32_000,
  }),
  memberRow("lengthy-refunds", lengthy, "running", {
    title: "Migrate refunds",
    profile: "worker",
    startedAt: 32_000,
  }),
];
const fanout = activityRow("fanout", "running", undefined, {
  title: "Ad-hoc fan-out",
  profile: "planner",
  startedAt: 0,
  actions: [stop],
});
const asking = memberRow("asking", fanout, "needs-input", {
  title: "Choose a library",
  profile: "researcher",
  startedAt: 10_000,
  inputTarget: "parent",
});
const fanoutRows: readonly ActivityRow[] = [
  fanout,
  asking,
  memberRow("fanout-worker", fanout, "running", {
    title: "Benchmark options",
    profile: "worker",
    startedAt: 10_000,
  }),
  activityRow("human", "needs-input", asking.id, {
    kind: "question",
    title: "Approve the dependency",
  }),
];
const scenarios: ReadonlyArray<{
  readonly title: string;
  readonly rows: readonly ActivityRow[];
  readonly tiers?: boolean;
}> = [
  { title: "Running parent with nested subagents and queued placeholders", rows: running },
  {
    title: "Running parent beside standalone agents and tasks",
    rows: [...running, ...standalone],
  },
  { title: "Stopped parent with stopped and never-started subagents", rows: stoppedRows },
  { title: "Failed subagent under a live parent", rows: failingRows },
  {
    title: "A long parent name beside attention counts",
    rows: lengthyRows,
    tiers: true,
  },
  { title: "Subagent waiting on its parent and an owned question", rows: fanoutRows },
  {
    title: "Clipped activity retains attention and hidden evidence",
    rows: [...running, ...failingRows, ...fanoutRows, ...stoppedRows, ...standalone],
  },
  {
    title: "Standalone queued and urgent questions",
    rows: [
      activityRow("queued", "pending", undefined, { kind: "question" }),
      activityRow("urgent", "needs-input", undefined, { kind: "question" }),
    ],
  },
];

const manager = (rows: readonly ActivityRow[], height: number) =>
  new ActivityComponent({
    snapshot: () => rows,
    theme: plainTheme,
    height: () => height,
    now: () => 90_000,
    close: () => undefined,
    invoke: () => undefined,
    requestRender: () => undefined,
  });
const select = (component: ActivityComponent, key: string, presses: number) => {
  for (let step = 0; step < presses && component.shell.state.selectedId !== key; step++)
    component.handleInput("j");
  return component.shell.state.selectedId === key;
};

const managerFrames = (rows: readonly ActivityRow[], tiers: boolean) => {
  const component = manager(rows, 24);
  const frames: Array<readonly [string, readonly string[]]> = [
    ["manager · 140 cols", component.render(140)],
  ];
  if (tiers) frames.push(["stacked manager · 80 cols", component.render(80)]);
  if (!rows.some((row) => row.parent !== undefined)) return frames;
  component.handleInput("\r");
  frames.push(["inspect parent", component.render(140)]);
  component.handleInput("h");
  component.handleInput("j");
  component.handleInput("\r");
  frames.push(["inspect first child", component.render(140)]);
  component.handleInput("h");
  const placeholder = rows.find((row) => row.status === "pending" && row.startedAt === undefined);
  if (placeholder && select(component, placeholder.key, 11)) {
    component.handleInput("\r");
    frames.push(["inspect queued placeholder", component.render(140)]);
    component.handleInput("h");
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
const footerScenarios: ReadonlyArray<readonly [string, readonly ActivityRow[], string]> = [
  ["One stop action", running, review.key],
  ["Queued placeholder stop action", running, queued[0]!.key],
  ["Several direct actions", [steered], steered.key],
  ["More actions than one page", [crowdedActions], crowdedActions.key],
  ["No actions", stoppedRows, stopped.key],
];
const footerFrames = (rows: readonly ActivityRow[], key: string) => {
  const component = manager(rows, 12);
  component.render(140);
  select(component, key, 16);
  const footer = (width: number, help: string) => {
    const line = component.render(width).at(-1);
    if (line === undefined) throw new Error("Manager footer was not rendered");
    return `${help}${width} cols ${line}`;
  };
  const footers = (help: string) => [140, 100, 80, 50].map((width) => footer(width, help));
  const lines = footers("");
  component.handleInput("?");
  const help = footers("? ");
  component.handleInput("?");
  const confirmable = rows.find((row) => row.key === key)?.actions?.[0]?.confirmation;
  if (!confirmable) return [...lines, ...help];
  component.handleInput("x");
  return [
    ...lines,
    ...help,
    ...component.render(80).map((line) => `confirm 80 cols ${line}`),
    footer(50, "confirm "),
  ];
};

const ignoreTick = () => {};

const workingFrames = () => {
  let time = 0;
  let message: string | undefined;
  let tick = ignoreTick;
  const row = makeWorkingRow({
    now: () => time,
    every: (_interval, callback) => {
      tick = callback;
      return () => {};
    },
  });
  row.activate(
    MutableRef.make(
      extensionContextFixture({
        mode: "tui",
        ui: {
          setWorkingMessage: (value?: string) => {
            message = value;
          },
        },
      }),
    ),
  );
  const lines: string[] = [];
  const capture = (label: string) =>
    lines.push(`── Working row · ${label}`, message ?? "(cleared)", "");
  row.agentStart();
  capture("no measured output");
  row.callStart();
  row.output(400);
  time = 2_000;
  tick();
  capture("current-call estimate");
  row.callEnd(240);
  capture("reported completed-call average");
  row.callStart();
  row.promptStart();
  capture("waiting while provider measurement continues");
  time = 4_000;
  row.promptEnd();
  row.callEnd(undefined);
  capture("unavailable completion leaves prior measured average intact");
  row.agentEnd();
  capture("settled");
  return lines;
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
      lines.push(...workingFrames());
      yield* writeGallerySection(
        directory,
        "pi-cosmic-ui",
        lines.map((line) => stripTerminalControls(line).replace(/\s+$/u, "")),
      );
    }),
  );
});
