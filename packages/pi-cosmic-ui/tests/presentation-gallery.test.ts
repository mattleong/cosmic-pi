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
import type { ActivityRow } from "../src/activity/model.ts";
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
  summary: "phase 2/3 · 3 queued",
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
    startedAt: 52_000,
    endedAt: 80_000,
  }),
  memberRow("e2e", failing, "Test", "running", {
    title: "End-to-end tests",
    profile: "worker",
    startedAt: 52_000,
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
const scenarios: ReadonlyArray<{ readonly title: string; readonly rows: readonly ActivityRow[] }> =
  [
    { title: "Running workflow with queued placeholders that can be skipped", rows: running },
    {
      title: "Running workflow beside standalone agents and tasks",
      rows: [...running, ...standalone],
    },
    { title: "Stopped workflow", rows: stoppedRows },
    { title: "Skipped phases after an early return", rows: earlyRows },
    { title: "Failed member in a live phase", rows: failingRows },
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

const managerFrames = (rows: readonly ActivityRow[]) => {
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
  if (!rows.some((row) => row.kind === "workflow")) return frames;
  component.handleInput("\r");
  frames.push(["inspect workflow", component.render(140)]);
  component.handleInput("h");
  component.handleInput("j");
  component.handleInput("\r");
  frames.push(["inspect first child", component.render(140)]);
  component.handleInput("h");
  const queued = rows.find((row) => row.status === "pending" && row.startedAt === undefined);
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
  component.handleInput("j");
  component.handleInput("h");
  frames.push(["collapsed manager · 100 cols", component.render(100)]);
  return frames;
};

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders grouped Activity states without source execution", () =>
    Effect.gen(function* () {
      const lines: string[] = [];
      for (const scenario of scenarios) {
        for (const width of [60, 80, 100])
          lines.push(
            `── ${scenario.title} · widget · ${width} cols`,
            ...renderActivityWidget(scenario.rows, width, activityWidgetHeight(scenario.rows, 24), {
              now: 90_000,
              theme: plainTheme,
            }),
            "",
          );
        for (const [label, frame] of managerFrames(scenario.rows))
          lines.push(`── ${scenario.title} · ${label}`, ...frame, "");
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(directory, "pi-cosmic-ui.txt"),
        `${lines.map((line) => stripTerminalControls(line).replace(/\s+$/u, "")).join("\n")}\n`,
      );
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});
