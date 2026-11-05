import { describe, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core";
import { countLabel } from "pi-cosmic-core/display";
import {
  extensionContextFixture,
  galleryDirectory,
  plainTheme,
  writeGallerySection,
} from "pi-cosmic-core/testing";
import { createWorkingRow } from "../src/working/row.ts";
import { getKeybindings } from "@earendil-works/pi-tui";
import { ActivityComponent } from "../src/activity/component.ts";
import { fullScreenKeybindingOptions } from "../src/manager/key-labels.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityInspectionKey, activityWidgetHeight } from "../src/activity/widget-projection.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import type { ActivityDetail } from "../src/activity/protocol.ts";
import { activityRow, memberRow } from "./support/activity.ts";
import { activitySectionId } from "../src/activity/grouped-tree.ts";
import { settingsCommandGalleryLines } from "./support/gallery-settings-command.ts";
import { sharedSurfaceGalleryLines } from "./support/gallery-shared-surfaces.ts";

const directory = galleryDirectory(process.env) ?? "";
// The words and models real producers publish: subagents name the item they stop and count the
// active subagents beneath it.
const stopAgent = (title: string, activeSubagents: number) => ({
  id: "stop",
  label: "Stop",
  confirmation:
    activeSubagents > 0
      ? `Stop "${title}" and its ${countLabel(activeSubagents, "subagent")}?`
      : `Stop "${title}"?`,
});
const stopQueued = [{ id: "stop", label: "Stop" }];
const routes = {
  planner: { model: "claude-bridge/claude-opus-5-5", modelDetail: "high" },
  reviewer: { model: "openai-codex/gpt-6-sol", modelDetail: "high" },
  scout: { model: "openai-codex/gpt-6-luna", modelDetail: "low" },
  worker: { model: "opencode/gpt-6.1-sol", modelDetail: "xhigh" },
  researcher: { model: "claude-bridge/claude-sonnet-5-5", modelDetail: "medium" },
} as const;
const agent = (profile: keyof typeof routes) => ({ profile, ...routes[profile] });
const standalone = [
  activityRow("docs", "running", undefined, {
    title: "Update documentation",
    ...agent("worker"),
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
  ...agent("planner"),
  summary: "Found 5 call sites; reviewing each one for token reuse",
  startedAt: 0,
  actions: [stopAgent("Review authentication", 5)],
});
const found = memberRow("finder", review, "done", {
  title: "Find call sites",
  ...agent("scout"),
  startedAt: 0,
  endedAt: 30_000,
});
const reviewers = Arr.map(["Session handling", "Token refresh"], (title, index) =>
  memberRow(`reviewer-${index}`, review, "running", {
    title,
    ...agent("reviewer"),
    startedAt: 35_000,
    actions: [{ id: "stop", label: "Stop" }],
  }),
);
const queued = Arr.map(["Password reset", "OAuth callback", "Rate limits"], (title, index) =>
  memberRow(`queued-${index}`, review, "pending", {
    title,
    ...agent("reviewer"),
    actions: stopQueued,
  }),
);
const running: readonly ActivityRow[] = [review, found, ...reviewers, ...queued];
const stopped = activityRow("stopped", "cancelled", undefined, {
  title: "Migrate settings store",
  ...agent("planner"),
  startedAt: 0,
  endedAt: 70_000,
});
const stoppedRows: readonly ActivityRow[] = [
  stopped,
  memberRow("planner", stopped, "done", {
    title: "Draft migration plan",
    ...agent("planner"),
    startedAt: 0,
    endedAt: 20_000,
  }),
  memberRow("implementer", stopped, "cancelled", {
    title: "Rewrite store",
    ...agent("worker"),
    startedAt: 25_000,
    endedAt: 70_000,
  }),
  memberRow("queued-verify", stopped, "cancelled", {
    title: "Port callers",
    ...agent("worker"),
  }),
];
const failing = activityRow("failing", "running", undefined, {
  title: "Release candidate",
  ...agent("planner"),
  startedAt: 0,
  actions: [stopAgent("Release candidate", 1)],
});
const failingRows: readonly ActivityRow[] = [
  failing,
  memberRow("build", failing, "done", {
    title: "Build packages",
    ...agent("worker"),
    startedAt: 0,
    endedAt: 50_000,
  }),
  memberRow("unit", failing, "failed", {
    title: "Unit tests",
    ...agent("worker"),
    summary: "3 assertions failed in session.test.ts",
    startedAt: 52_000,
    endedAt: 80_000,
  }),
  memberRow("e2e", failing, "running", {
    title: "End-to-end tests",
    ...agent("worker"),
    startedAt: 52_000,
  }),
];
const lengthy = activityRow("lengthy", "running", undefined, {
  title: "Migrate every billing service to the consolidated settings schema",
  ...agent("planner"),
  startedAt: 0,
  actions: [stopAgent("Migrate every billing service to the consolidated settings schema", 2)],
});
const lengthyRows: readonly ActivityRow[] = [
  lengthy,
  memberRow("lengthy-inventory", lengthy, "done", {
    title: "Inventory billing services",
    ...agent("scout"),
    startedAt: 0,
    endedAt: 30_000,
  }),
  memberRow("lengthy-invoices", lengthy, "blocked", {
    title: "Migrate invoices",
    ...agent("worker"),
    blockedReason: "write-containment",
    startedAt: 32_000,
  }),
  memberRow("lengthy-refunds", lengthy, "running", {
    title: "Migrate refunds",
    ...agent("worker"),
    startedAt: 32_000,
  }),
];
const fanout = activityRow("fanout", "running", undefined, {
  title: "Ad-hoc fan-out",
  ...agent("planner"),
  startedAt: 0,
  actions: [stopAgent("Ad-hoc fan-out", 2)],
});
const asking = memberRow("asking", fanout, "needs-input", {
  title: "Choose a library",
  ...agent("researcher"),
  startedAt: 10_000,
  inputTarget: "parent",
});
const fanoutRows: readonly ActivityRow[] = [
  fanout,
  asking,
  memberRow("fanout-worker", fanout, "running", {
    title: "Benchmark options",
    ...agent("worker"),
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

// Pi hands the manager its configured select keys, such as `escape`/`ctrl+c` for cancel.
const piKeybindings = () => fullScreenKeybindingOptions(getKeybindings());

const manager = (rows: readonly ActivityRow[], height: number) =>
  new ActivityComponent({
    ...piKeybindings(),
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
    ["manager · narrow · 57 cols", component.render(57)],
  ];
  if (tiers) frames.push(["stacked manager · 80 cols", component.render(80)]);
  if (!Arr.some(rows, (row) => row.parent !== undefined)) return frames;
  component.handleInput("\r");
  frames.push(["inspect parent", component.render(140)]);
  component.handleInput("h");
  component.handleInput("j");
  component.handleInput("\r");
  frames.push(["inspect first child", component.render(140)]);
  component.handleInput("h");
  const placeholder = Option.getOrUndefined(
    Arr.findFirst(rows, (row) => row.status === "pending" && row.startedAt === undefined),
  );
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
  ...agent("worker"),
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
  [
    "Direct and numbered actions together",
    [
      {
        ...steered,
        actions: [
          { id: "stop", label: "Stop" },
          { id: "export", label: "Export transcript" },
          { id: "pin", label: "Pin" },
        ],
      },
    ],
    steered.key,
  ],
  ["More actions than one page", [crowdedActions], crowdedActions.key],
  ["No actions", stoppedRows, stopped.key],
];
const footerFrames = (rows: readonly ActivityRow[], key: string) => {
  const component = manager(rows, 12);
  component.render(140);
  select(component, key, 16);
  // A bar wider than the border wraps into rows above it; show those rows with the border.
  const footer = (width: number, help: string) => {
    const frame = component.render(width);
    let start = frame.length - 1;
    while (start > 0 && /^│ \S/u.test(frame[start - 1] ?? "")) start--;
    if (start < frame.length - 1 && Str.startsWith("├")(frame[start - 1] ?? "")) start--;
    else start = frame.length - 1;
    return Arr.map(frame.slice(start), (line) => `${help}${width} cols ${line}`);
  };
  const footers = (help: string) => Arr.flatMap([180, 100, 80, 57], (width) => footer(width, help));
  const lines = footers("");
  component.handleInput("?");
  const help = footers("? ");
  component.handleInput("?");
  const confirmable = Option.getOrUndefined(Arr.findFirst(rows, (row) => row.key === key))
    ?.actions?.[0]?.confirmation;
  if (!confirmable) return [...lines, ...help];
  component.handleInput("x");
  return [
    ...lines,
    ...help,
    ...Arr.map(component.render(80), (line) => `confirm 80 cols ${line}`),
    ...footer(57, "confirm "),
  ];
};

const taskOutput = Arr.join(
  Arr.map(Arr.range(1, 30), (tick) => `tick ${tick}`),
  "\n",
);
const ticker = activityRow("ticker", "running", undefined, {
  title: "ticker",
  kind: "command",
  startedAt: 30_000,
  updatedAt: 89_000,
  summary: "running",
  actions: [{ id: "stop", label: "Stop", confirmation: 'Stop "ticker" and its process tree?' }],
});
const flaky = activityRow("flaky", "failed", undefined, {
  title: "flaky build",
  kind: "command",
  startedAt: 20_000,
  endedAt: 26_000,
  summary: "Exited with code 2: missing semicolon",
  actions: [
    {
      id: "clear",
      label: "Clear all finished",
      confirmation: "Clear all finished tasks from this session? Running tasks keep running.",
    },
  ],
});
const checker = activityRow("checker", "done", undefined, {
  title: "Check tests",
  ...agent("scout"),
  model: "openai-codex/gpt-6-sol",
  modelDetail: "low (override)",
  startedAt: 0,
  endedAt: 33_000,
  actions: [{ id: "resume", label: "Resume" }],
});
const taskDetails = {
  ticker: {
    sections: [
      { title: "Output", body: taskOutput },
      { title: "Command", body: "for i in $(seq 1 600); do echo tick $i; sleep 1; done" },
    ],
    technical: [
      { label: "ID", value: "task-2d9mk1xp82" },
      { label: "PID", value: "30502" },
      { label: "Started", value: "Nov 3, 10:59 PM" },
      { label: "Directory", value: "/private/tmp/ui-review/sandbox" },
      { label: "Log cursor", value: "30" },
    ],
  },
  flaky: {
    sections: [
      { body: "Exited with code 2: missing semicolon" },
      { title: "Output", body: "compiling\nerror: missing semicolon" },
      {
        title: "Command",
        body: "sleep 6; echo compiling; echo error: missing semicolon >&2; exit 2",
      },
    ],
    technical: [
      { label: "ID", value: "task-7q1c0aa1zz" },
      { label: "Exit", value: "code 2 (misuse of shell builtins) · signal none" },
      { label: "Started", value: "Nov 3, 10:59 PM" },
      { label: "Ended", value: "Nov 3, 10:59 PM" },
    ],
  },
  checker: {
    sections: [
      {
        title: "Result",
        format: "markdown",
        body: "`src/cart.test.ts` tests three functions: `subtotal`, `applyDiscount`, and `itemCount`.\n\n- Start here: **`src/cart.test.ts`**",
      },
      { title: "Task", body: "Read src/cart.test.ts and list the tested functions." },
      { title: "Recent activity", body: "bash · sleep 25 · done\nread · src/cart.test.ts · done" },
      { body: "22k tokens (125 output) · ~$0.02 · 2 tool uses" },
    ],
    technical: [
      { label: "ID", value: "agent-25fzx71b0s" },
      { label: "Report", value: "delivered to the parent" },
      { label: "Session", value: "~/.pi/agent/subagents/01a1a537/agent-25fzx71b0s.jsonl" },
    ],
  },
} satisfies Readonly<Record<string, ActivityDetail>>;
const detailedRows: readonly ActivityRow[] = [checker, ticker, flaky];

const detailedManager = (height: number) =>
  new ActivityComponent({
    ...piKeybindings(),
    snapshot: () => detailedRows,
    theme: plainTheme,
    height: () => height,
    now: () => 90_000,
    close: () => undefined,
    invoke: () => undefined,
    requestRender: () => undefined,
    loadDetail: (request, deliver) => {
      const row = Option.getOrUndefined(
        Arr.findFirst(detailedRows, (candidate) => candidate.key === request.key),
      );
      const detail =
        row &&
        Option.getOrUndefined(
          Arr.findFirst(Rec.toEntries(taskDetails), ([id]) => id === row.id),
        )?.[1];
      if (detail) deliver(detail);
    },
  });

const detailFrames = () => {
  const frames: string[] = [];
  const capture = (label: string, frame: readonly string[]) =>
    frames.push(`── Activity details · ${label}`, ...frame, "");
  const component = detailedManager(26);
  capture("subagent report preview · 140 cols", component.render(140));
  component.handleInput("\r");
  capture("subagent report inspected", component.render(140));
  component.handleInput("t");
  capture("subagent report with technical details", component.render(140));
  component.handleInput("t");
  component.handleInput("\u001b");
  select(component, ticker.key, 8);
  capture("running task preview", component.render(140));
  component.handleInput("f");
  capture("running task followed from the list", component.render(140));
  component.handleInput("f");
  select(component, flaky.key, 8);
  capture("failed task preview leads with its cause", component.render(140));
  component.handleInput("\r");
  component.handleInput("t");
  capture("failed task inspected with technical details", component.render(140));
  capture("failed task inspected · stacked · 80 cols", component.render(80));
  capture("failed task inspected · narrow · 57 cols", component.render(57));
  component.handleInput("?");
  capture("expanded help while inspecting", component.render(140));
  capture("expanded help while inspecting · narrow · 57 cols", component.render(57));
  component.handleInput("?");
  component.handleInput("t");
  component.handleInput("\u001b");
  component.handleInput("g");
  component.handleInput("g");
  select(component, ticker.key, 8);
  component.handleInput("\r");
  component.render(57);
  component.handleInput("G");
  capture("running task scrolled to its end · narrow · 57 cols", component.render(57));
  component.handleInput("\u001b");
  capture("list · narrow · 57 cols", component.render(57));
  const tasks = activitySectionId("tasks");
  for (let step = 0; step < 8 && component.shell.state.selectedId !== tasks; step++)
    component.handleInput("k");
  capture("group summary · 140 cols", component.render(140));
  capture("group summary · narrow · 57 cols", component.render(57));
  // The list-only layout has no detail heading, so the title carries `following`.
  const phone = detailedManager(26);
  phone.render(57);
  select(phone, ticker.key, 8);
  phone.handleInput("f");
  capture("running task followed from the list · narrow · 57 cols", phone.render(57));
  return frames;
};

const liveTicker = activityRow("live-ticker", "running", undefined, {
  title: "ticker",
  kind: "command",
  startedAt: 72_000,
  summary: "tick 18",
});
const liveServer = activityRow("live-server", "running", undefined, {
  title: "dev server",
  kind: "command",
  startedAt: 76_000,
  summary: "listening on http://localhost:4173",
});
const liveAgents = [
  activityRow("live-checker", "running", undefined, {
    title: "Check tests",
    ...agent("scout"),
    model: "openai-codex/gpt-6-luna",
    modelDetail: "high ⚡",
    startedAt: 80_000,
    summary: "running bash · sleep 25",
  }),
  activityRow("live-mapper", "running", undefined, {
    title: "Map cart module",
    ...agent("reviewer"),
    model: "claude-bridge/claude-opus-5-5",
    modelDetail: "high",
    startedAt: 80_000,
    summary: "running read · src/cart.ts",
  }),
  activityRow("live-fallback", "running", undefined, {
    title: "Read tests",
    ...agent("scout"),
    model: "openai-codex/gpt-6-sol",
    modelDetail: "high (fallback)",
    startedAt: 84_000,
    summary: "thinking",
  }),
  activityRow("live-override", "running", undefined, {
    title: "Fix login",
    ...agent("worker"),
    model: "opencode/gpt-6.1-sol",
    modelDetail: "xhigh (override)",
    startedAt: 86_000,
    summary: "running edit · src/auth.ts",
  }),
];
const liveRows: readonly ActivityRow[] = [...liveAgents, liveServer, liveTicker, flaky];

const liveFrames = () => {
  const lines: string[] = [];
  for (const width of [180, 100, 72, 57, 40])
    lines.push(
      `── Live progress · widget · ${width} cols`,
      ...renderActivityWidget(liveRows, width, 8, { now: 90_000, theme: plainTheme }),
      "",
    );
  // A wall-clock `now` beside a start recorded as 1 or in the future shows no elapsed time.
  const clock = Date.UTC(2026, 10, 4);
  const implausible = [
    activityRow("unset-start", "running", undefined, {
      title: "Audit retries",
      ...agent("worker"),
      startedAt: 1,
    }),
    activityRow("skewed-start", "running", undefined, {
      title: "Sync mirrors",
      kind: "command",
      startedAt: clock + 60_000,
    }),
    activityRow("measured", "running", undefined, {
      title: "Index docs",
      ...agent("scout"),
      startedAt: clock - 95_000,
    }),
  ];
  for (const width of [100, 57])
    lines.push(
      `── Live progress · widget · implausible starts show no elapsed time · ${width} cols`,
      ...renderActivityWidget(implausible, width, 8, { now: clock, theme: plainTheme }),
      "",
    );
  const inspected = new Set([activityInspectionKey(flaky)]);
  lines.push(
    "── Live progress · widget · failure inspected in Activity · 100 cols",
    ...renderActivityWidget(liveRows, 100, 8, { now: 90_000, theme: plainTheme, inspected }),
    "",
    "── Live progress · widget · failure line expires after ten minutes · 100 cols",
    ...renderActivityWidget(liveRows, 100, 8, { now: 26_000 + 10 * 60_000 + 1, theme: plainTheme }),
    "",
  );
  const component = manager(liveRows, 24);
  lines.push(
    "── Live progress · manager · 180 cols",
    ...component.render(180),
    "",
    "── Live progress · manager · narrow · 57 cols",
    ...component.render(57),
    "",
  );
  return lines;
};

const attentionRows = (phase: "open" | "hidden"): readonly ActivityRow[] => [
  ticker,
  activityRow("deploy", "needs-input", undefined, {
    title: "Deploy",
    kind: "question",
    providerId: "pi-ask-user",
    summary: phase === "open" ? "open" : "/ask-user to resume",
    actions:
      phase === "open"
        ? [{ id: "cancel", label: "Cancel" }]
        : [
            { id: "resume", label: "Resume" },
            { id: "cancel", label: "Cancel" },
          ],
  }),
  activityRow("answered", "done", undefined, {
    title: "Persistence / Features / Notes",
    kind: "question",
    endedAt: 10_000,
  }),
];

const attentionWidget = (
  label: string,
  rows: readonly ActivityRow[],
  docked: boolean,
  width = 80,
) => [
  `── Attention · widget · ${label}`,
  ...renderActivityWidget(rows, width, docked ? 3 : 8, {
    now: 90_000,
    theme: plainTheme,
    inputDockVisible: docked,
  }),
  "",
];

const attentionFrames = () => {
  const widget = attentionWidget;
  return [
    ...widget("questionnaire open in its dock", attentionRows("open"), true),
    ...widget("questionnaire hidden", attentionRows("hidden"), false),
    `── Attention · manager · answered questionnaire leaves Attention`,
    ...manager(attentionRows("hidden"), 12).render(120),
    "",
    `── Attention · manager · answered questionnaire leaves Attention · narrow · 57 cols`,
    ...manager(attentionRows("hidden"), 12).render(57),
    "",
    `── Attention · manager · waiting question scrolled out of view banners above the list`,
    ...manager([...attentionRows("hidden"), ...running], 12).render(120),
    "",
    ...widget("questionnaire hidden · 57 cols", attentionRows("hidden"), false, 57),
    ...widget("finished failure outside the live checklist", [ticker, flaky], false),
    ...widget(
      "several recent failures",
      [ticker, flaky, { ...flaky, key: "x", id: "x", title: "lint" }],
      false,
    ),
  ];
};

// Long models under nested branches: a row that can't keep its whole `provider/model` beside a
// readable title moves the identity to a second line instead of cutting the model.
const audit = activityRow("audit", "running", undefined, {
  title: "Audit the payment retry pipeline",
  ...agent("researcher"),
  startedAt: 0,
  actions: [stopAgent("Audit the payment retry pipeline", 2)],
});
const auditLead = memberRow("audit-lead", audit, "running", {
  title: "Compare idempotency keys",
  ...agent("researcher"),
  startedAt: 20_000,
});
const nestedModelRows: readonly ActivityRow[] = [
  audit,
  auditLead,
  activityRow("audit-leaf", "running", auditLead.id, {
    title: "Trace webhook replays",
    ...agent("planner"),
    startedAt: 40_000,
  }),
  memberRow("audit-docs", audit, "done", {
    title: "api-audit",
    ...agent("researcher"),
    startedAt: 0,
    endedAt: 50_000,
  }),
];

const edgeFrames = () => {
  const lines: string[] = [];
  const capture = (label: string, frame: readonly string[]) =>
    lines.push(`── ${label}`, ...frame, "");
  for (const width of [57, 100, 140])
    capture(
      `Nested long models · manager · ${width} cols`,
      manager(nestedModelRows, 12).render(width),
    );
  for (const width of [57, 100])
    capture(
      `Nested long models · widget · ${width} cols`,
      renderActivityWidget(nestedModelRows, width, 8, { now: 90_000, theme: plainTheme }),
    );
  const deep = manager(nestedModelRows, 12);
  deep.render(57);
  select(deep, activityKeyOf(nestedModelRows, "audit-leaf"), 6);
  capture("Nested long models · wrapped row focused · 57 cols", deep.render(57));
  for (const width of [57, 140]) {
    const empty = manager([], 10);
    capture(`Empty Activity · ${width} cols`, empty.render(width));
    empty.handleInput("?");
    capture(`Empty Activity · expanded help · ${width} cols`, empty.render(width));
  }
  for (const width of [57, 140]) {
    const confirming = manager(running, 10);
    confirming.render(width);
    confirming.handleInput("x");
    capture(`Stop confirmation · ${width} cols`, confirming.render(width));
  }
  for (const width of [57, 140]) {
    const helped = manager(running, 16);
    helped.render(width);
    helped.handleInput("?");
    capture(`Expanded help in the list · ${width} cols`, helped.render(width));
  }
  return lines;
};

const activityKeyOf = (rows: readonly ActivityRow[], id: string): string =>
  Option.getOrElse(
    Option.map(
      Arr.findFirst(rows, (row) => row.id === id),
      (row) => row.key,
    ),
    () => id,
  );

const ignoreTick = () => {};

const workingFrames = () => {
  let time = 0;
  let message: string | undefined;
  let tick = ignoreTick;
  const row = createWorkingRow({
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
  capture("between calls, such as while a tool runs, shows no rate");
  row.callStart();
  capture("next call starts from the measured average");
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
          ...Arr.map(
            [57, 80, 100, 180],
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
      lines.push(...detailFrames(), ...liveFrames(), ...attentionFrames(), ...edgeFrames());
      lines.push(...workingFrames());
      lines.push(...sharedSurfaceGalleryLines());
      lines.push(...(yield* settingsCommandGalleryLines()));
      yield* writeGallerySection(
        directory,
        "pi-cosmic-ui",
        Arr.map(lines, (line) => Fn.pipe(stripTerminalControls(line), Str.replace(/\s+$/u, ""))),
      );
    }),
  );
});
