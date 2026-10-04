// Promise assertions are test-runner boundaries.
import { describe, expect, it } from "@effect/vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { beforeEach } from "vitest";
import {
  registerWorkflowTool,
  workflowToolDescription,
  type WorkflowToolRuntime,
} from "../../src/tools/workflow.ts";
import {
  WORKFLOW_END_TURN_TEXT,
  WORKFLOW_STOP_GUIDANCE,
  workflowListText,
  workflowRunSummary,
} from "../../src/tools/workflow-format.ts";
import {
  workflowCompactSummary,
  type WorkflowToolArgs,
} from "../../src/tools/workflow-presentation.ts";
import { countWorkflowRunAgents, type WorkflowRunView } from "../../src/workflow/model.ts";
import { WORKFLOW_BUDGET_ERROR } from "../../src/workflow/prelude.ts";
import { WorkflowService } from "../../src/workflow/service.ts";
import { WORKFLOW_STATUS_REPEAT_MS } from "../../src/workflow/status-repeat.ts";
import { workflowRunView } from "../fixtures/run-view.ts";
import {
  decodeWorkflowToolDetails,
  type WorkflowToolDetails,
} from "../../src/tools/workflow-schema.ts";
import {
  inline,
  memoryLocations,
  reportTask,
  runWhere,
  script,
  testHost,
  workflowFixture,
} from "../workflow/fixtures/workflow-harness.ts";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const renderOnly: WorkflowToolRuntime = {
  environment: { cwd: "/project", projectTrusted: false },
  savedWorkflowLocations: memoryLocations,
  run: () => Promise.reject(new Error("render-only fixture")),
};

const registeredTool = (runtime: WorkflowToolRuntime = renderOnly) => {
  const [tool] = captureRegistrations((pi) => registerWorkflowTool(pi, runtime)).tools;
  return tool!;
};

/** The live clock moved ahead by `shift.ms`, so a test can jump past a window; sleeps stay live. */
const shiftedClock = (live: Clock.Clock, shift: { ms: number }): Clock.Clock => {
  const millis = () => live.currentTimeMillisUnsafe() + shift.ms;
  const nanos = () => live.currentTimeNanosUnsafe() + BigInt(shift.ms) * 1_000_000n;
  return {
    currentTimeMillisUnsafe: millis,
    currentTimeMillis: Effect.sync(millis),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
};

/**
 * The registered tool over the real workflow and subagent services, with `clock` as the wall
 * clock when given. `startRun` starts an inline script on the service directly, whose agents the
 * harness's host launches, so a test can report them.
 */
const liveTool = (scripts: Readonly<Record<string, string>> = {}, clock?: Clock.Clock) => {
  const fixture = workflowFixture({ scripts });
  const services = Layer.merge(fixture.layer, fixture.backend.layer);
  const runtime = ManagedRuntime.make(
    clock === undefined ? services : Layer.merge(services, Layer.succeed(Clock.Clock, clock)),
  );
  const onService = <A, E>(
    effect: (workflows: typeof WorkflowService.Service) => Effect.Effect<A, E>,
  ) => Effect.promise(() => runtime.runPromise(WorkflowService.use(effect)));
  const startRun = (body: string) =>
    onService((workflows) => workflows.start({ source: inline(body), args: null }, testHost()));
  const runMatching = (id: string, predicate: (run: WorkflowRunView) => boolean) =>
    onService((workflows) => runWhere(workflows, id, predicate));
  const tool = registeredTool({
    environment: { cwd: "/project", projectTrusted: false },
    savedWorkflowLocations: memoryLocations,
    run: (effect, signal) => runtime.runPromise(effect, { signal }),
  });
  const ctx = extensionContextFixture({ cwd: "/project", hasUI: false });
  const execute = (args: Partial<WorkflowToolArgs>) =>
    Effect.promise(
      () =>
        // SAFETY: the registered execute returns Pi tool results with this tool's details.
        tool.execute("call", args, undefined, undefined, ctx) as Promise<
          AgentToolResult<WorkflowToolDetails> & { readonly isError?: boolean }
        >,
    );
  return {
    execute,
    fixture,
    startRun,
    runMatching,
    dispose: Effect.promise(() => runtime.dispose()),
  };
};

const textOf = (result: AgentToolResult<WorkflowToolDetails>) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

const detailsOf = (result: AgentToolResult<WorkflowToolDetails>) => {
  const decoded = decodeWorkflowToolDetails(result.details);
  if (decoded._tag === "None") throw new Error("Expected versioned workflow details");
  return decoded.value;
};

describe("subagent_workflow tool", () => {
  it("is model-only so codemode scripts can't start workflows", () => {
    expect(registeredTool().exposure).toBe("model-only");
  });

  it.live("starts a background run and reports its progress and result", () =>
    Effect.gen(function* () {
      const { execute, dispose } = liveTool();
      const started = yield* execute({
        action: "start",
        script: script('phase("Only"); return { ok: true, args };'),
        args: { n: 1 },
      });
      const run = detailsOf(started).run!;
      expect(started.isError).toBeUndefined();
      expect(textOf(started)).toContain(run.id);
      // The start tells the main agent to end its turn and wait for the notification.
      expect(textOf(started)).toContain(WORKFLOW_END_TURN_TEXT);
      let status = yield* execute({ action: "status", runId: run.id });
      for (
        let attempt = 0;
        attempt < 200 && detailsOf(status).run?.state === "running";
        attempt++
      ) {
        yield* Effect.sleep("10 millis");
        status = yield* execute({ action: "status", runId: run.id });
      }
      expect(detailsOf(status).run?.state).toBe("completed");
      expect(textOf(status)).toContain('"ok": true');
      const stopped = yield* execute({ action: "stop", runId: run.id });
      expect(detailsOf(stopped).run?.state).toBe("completed");
      const listed = yield* execute({ action: "list" });
      expect(detailsOf(listed)).toMatchObject({ action: "list", runs: 1, saved: 0 });
      yield* dispose;
    }),
  );

  it.live("starts a script given without an action, like Claude Code's Workflow tool", () =>
    Effect.gen(function* () {
      const { execute, dispose } = liveTool();
      const started = yield* execute({ script: script("return 1;") });
      expect(started.isError).toBeUndefined();
      expect(detailsOf(started)).toMatchObject({ action: "start" });
      const unclear = yield* execute({ runId: detailsOf(started).run!.id });
      expect(unclear.isError).toBe(true);
      yield* dispose;
    }),
  );

  it.live("returns plain-sentence issues for calls that can't run", () =>
    Effect.gen(function* () {
      // The edit loop restarts an inline script's copy, inside its run's directory.
      const copy = (runId: string) => `/agent/subagents/workflow-runs/${runId}/script.js`;
      const { execute, dispose } = liveTool({
        [copy("wf-mgb3k2x-1")]: script("const x = ;\nreturn x;"),
        [copy("wf-mgb3k2x-2")]: 'export const meta = { name: 5, description: "d" };\nreturn 1;',
      });
      const rejected = [
        yield* execute({ action: "start", script: script("return 1;"), name: "saved" }),
        yield* execute({ action: "start", script: script("return (;") }),
        yield* execute({ action: "start", script: "return 1;" }),
        yield* execute({ action: "start", name: "missing" }),
        yield* execute({ action: "start", scriptPath: copy("wf-mgb3k2x-1") }),
        yield* execute({ action: "start", scriptPath: copy("wf-mgb3k2x-2") }),
        yield* execute({ action: "start", scriptPath: copy("wf-mgb3k2x-3") }),
        yield* execute({ action: "status", runId: "wf-unknown-1" }),
        yield* execute({ action: "start", script: script("return 1;"), resumeFromRunId: "wf-x-9" }),
        yield* execute({ action: "status" }),
      ];
      const forbidden = ["wf-unknown-1", "wf-x-9", "wf-mgb3k2x", "/agent/", "Save it as"];
      for (const result of rejected) {
        expect(result.isError).toBe(true);
        const issue = detailsOf(result).issue!;
        expect(issueMessageStyleProblems(issue.message, { forbidden }), issue.message).toEqual([]);
        // A syntax error names its line once, as people read it, not the parser's position.
        expect(issue.message, issue.message).not.toMatch(/\(\d+:\d+\)/u);
        // The agent keeps the full explanation.
        expect(textOf(result).length).toBeGreaterThan(issue.message.length);
      }
      yield* dispose;
    }),
  );
});

describe("subagent_workflow status repeats", () => {
  /** The subagent run ids of a run's agents that are running, which full status rows name. */
  const runningIds = (run: WorkflowRunView) =>
    run.agents.filter((agent) => agent.state === "running").map((agent) => agent.runId);

  const fanOut = (tasks: ReadonlyArray<string>) =>
    `return await parallel(${JSON.stringify(tasks)}.map((task) => () => agent(task)));`;

  it.live("answers a repeat with nothing new in one line until something changes", () =>
    Effect.gen(function* () {
      const shift = { ms: 0 };
      const { execute, fixture, startRun, runMatching, dispose } = liveTool(
        {},
        shiftedClock(yield* Clock.Clock, shift),
      );
      const status = (runId: string) => execute({ action: "status", runId });
      const unchanged = (runId: string) =>
        status(runId).pipe(Effect.map((result) => detailsOf(result).unchanged === true));

      const first = yield* startRun(fanOut(["first", "second"]));
      const both = yield* runMatching(first.id, (run) => countWorkflowRunAgents(run).running === 2);
      const full = yield* status(first.id);
      expect(detailsOf(full).unchanged).toBeUndefined();
      for (const runId of runningIds(both)) expect(textOf(full)).toContain(runId);

      const repeated = yield* status(first.id);
      expect(detailsOf(repeated)).toMatchObject({
        action: "status",
        unchanged: true,
        run: { id: first.id, state: "running", running: 2 },
      });
      // The short answer leaves out the agent rows the full status lists.
      for (const runId of runningIds(both)) expect(textOf(repeated)).not.toContain(runId);
      expect(textOf(repeated).length).toBeLessThan(textOf(full).length);

      // Each run keeps its own last call: another run's first status is full.
      const other = yield* startRun(fanOut(["third"]));
      yield* runMatching(other.id, (run) => countWorkflowRunAgents(run).running === 1);
      expect(yield* unchanged(other.id)).toBe(false);
      expect(yield* unchanged(first.id)).toBe(true);
      expect(yield* unchanged(other.id)).toBe(true);

      // An agent that finishes is a change, after which repeats are short again.
      yield* reportTask(fixture, "first", "first done");
      yield* runMatching(first.id, (run) => countWorkflowRunAgents(run).completed === 1);
      expect(yield* unchanged(first.id)).toBe(false);
      expect(yield* unchanged(first.id)).toBe(true);

      // A call once the window has passed gets the full status.
      shift.ms += WORKFLOW_STATUS_REPEAT_MS + 1_000;
      expect(yield* unchanged(first.id)).toBe(false);
      expect(yield* unchanged(first.id)).toBe(true);

      // A finished run always gets its full status, with its result.
      yield* reportTask(fixture, "second", "second done");
      yield* runMatching(first.id, (run) => run.endedAt !== undefined);
      for (let call = 0; call < 2; call++) {
        const ended = yield* status(first.id);
        expect(detailsOf(ended).unchanged).toBeUndefined();
        expect(detailsOf(ended).run?.state).toBe("completed");
        expect(textOf(ended)).toContain("second done");
      }

      // Stopping a run the main agent started says when to stop one.
      const stopped = yield* execute({ action: "stop", runId: other.id });
      expect(detailsOf(stopped).run?.state).toBe("stopped");
      expect(textOf(stopped)).toContain(WORKFLOW_STOP_GUIDANCE);
      yield* dispose;
    }),
  );

  it("says in the description when to stop a run", () => {
    expect(registeredTool().description).toContain(WORKFLOW_STOP_GUIDANCE);
  });
});

describe("subagent_workflow args schemas", () => {
  const targeted =
    'export const meta = { name: "targeted", description: "d", args: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } };\nreturn args;';

  it.live("refuses args that don't match meta.args, naming the path and the args to pass", () =>
    Effect.gen(function* () {
      const { execute, dispose } = liveTool();
      for (const args of [{ target: 3 }, undefined]) {
        const result = yield* execute({
          action: "start",
          script: targeted,
          ...(args !== undefined && { args }),
        });
        expect(result.isError).toBe(true);
        const issue = detailsOf(result).issue!;
        expect(issueMessageStyleProblems(issue.message), issue.message).toEqual([]);
        expect(issue.message).toContain(args === undefined ? "args" : "args.target");
        // The agent gets every problem and the args the workflow expects.
        expect(issue.detail).toContain("target: string");
        expect(textOf(result)).toContain("target: string");
      }
      const started = yield* execute({ action: "start", script: targeted, args: { target: "x" } });
      expect(started.isError).toBeUndefined();
      yield* dispose;
    }),
  );

  it.live("keeps the refusal row in style for long paths, long problems and many problems", () =>
    Effect.gen(function* () {
      const { execute, dispose } = liveTool();
      const options = ["first", "second", "third"].map((word) => `"a-long-option-name-${word}"`);
      const item = `{ type: "object", properties: { someVeryLongPropertyNameForEachFileEntry: { enum: [${options.join(", ")}] } } }`;
      const schema = `{ type: "object", properties: { files: { type: "array", items: ${item} } } }`;
      const result = yield* execute({
        action: "start",
        script: `export const meta = { name: "wide", description: "d", args: ${schema} };\nreturn args;`,
        args: {
          files: Array.from({ length: 12 }, () => ({
            someVeryLongPropertyNameForEachFileEntry: 1,
          })),
        },
      });
      expect(result.isError).toBe(true);
      const issue = detailsOf(result).issue!;
      expect(issueMessageStyleProblems(issue.message), issue.message).toEqual([]);
      expect(issue.message).toContain("args.files[");
      yield* dispose;
    }),
  );
});

describe("subagent_workflow presentation", () => {
  const longScript = script(
    Array.from({ length: 20 }, (_, index) => `log("step ${index}");`).join("\n") +
      '\nreturn "LAST_LINE_SENTINEL";',
  );

  it("keeps the full script and exact arguments through expansion", () => {
    const harness = createToolPresentationHarness(registeredTool());
    const states = harness.cycle(
      { action: "start", script: longScript, args: { files: ["a.ts"] } },
      {
        content: [{ type: "text", text: "Started workflow OUTPUT_SENTINEL" }],
        details: {
          version: 1,
          action: "start",
          run: {
            id: "wf-a-1",
            name: "test-workflow",
            state: "running",
            phases: 1,
            agents: 0,
            queued: 0,
            running: 0,
            failed: 0,
            skipped: 0,
            reused: 0,
            startedAt: 1,
          },
        },
      },
    );
    for (const { expanded, text } of states) {
      expect(text).toContain("test-workflow");
      expect(text.includes("LAST_LINE_SENTINEL")).toBe(expanded);
      expect(text.includes('"a.ts"')).toBe(expanded);
      expect(text.includes("OUTPUT_SENTINEL")).toBe(expanded);
    }
  });

  it("shows a failed run's error as an issue without its run id", () => {
    const harness = createToolPresentationHarness(registeredTool());
    const states = harness.cycle(
      { action: "status", runId: "wf-a-1" },
      {
        content: [{ type: "text", text: "Workflow failed" }],
        details: {
          version: 1,
          action: "status",
          run: {
            id: "wf-a-1",
            name: "review",
            state: "failed",
            phases: 1,
            agents: 2,
            queued: 0,
            running: 0,
            failed: 1,
            skipped: 0,
            reused: 0,
            startedAt: 1,
            endedAt: 2,
            failure: "bad input",
          },
        },
      },
    );
    for (const { expanded, text } of states) {
      expect(text).toContain("bad input");
      if (!expanded) expect(text).not.toContain("wf-a-1");
    }
  });

  it("names a spent budget for people and keeps the budget error's agent-facing text for expansion", () => {
    const failure =
      "The workflow's token budget is spent: 512340 of 500000 output tokens. agent() can't start more agents; check budget.remaining() before calling it.";
    const run = workflowRunSummary(
      workflowRunView({
        state: "failed",
        endedAt: 2,
        budget: { total: 500_000, spent: 512_340, refused: 1 },
        failure: { name: WORKFLOW_BUDGET_ERROR, message: failure },
      }),
    );
    const args = { action: "status", runId: run.id } as const;
    const result: AgentToolResult<WorkflowToolDetails> = {
      content: [{ type: "text", text: `Workflow failed: ${failure}` }],
      details: { version: 1, action: "status", run },
    };
    const issues =
      workflowCompactSummary({
        phase: "settled",
        args,
        result,
        context: renderContextFixture(),
      })?.issues ?? [];
    expect(issues).toHaveLength(1);
    for (const issue of issues) {
      expect(issueMessageStyleProblems(issue.message, { forbidden: ["agent()"] })).toEqual([]);
      expect(issue.detail).toBe(failure);
    }
    for (const { expanded, text } of createToolPresentationHarness(registeredTool()).cycle(
      args,
      result,
    ))
      expect(text.includes("budget.remaining()")).toBe(expanded);
  });

  it("never passes terminal control sequences from the script to the screen", () => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false });
    const hostile = script(
      'await agent("Summarize \u001b[2J\u001b]8;;https://example.test\u0007this file\u001b]8;;\u0007");',
    );
    const harness = createToolPresentationHarness(registeredTool());
    for (const expanded of [false, true]) {
      harness.call({ action: "start", script: hostile }, { expanded });
      const rendered = harness.render(160).join("\n");
      expect(rendered).toContain("this file");
      expect(rendered).not.toContain("\u001b[2J");
      expect(rendered).not.toContain("\u001b]8;;");
    }
  });

  it("previews an inline script within a bounded number of rows", () => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false });
    const harness = createToolPresentationHarness(registeredTool());
    harness.call({ action: "start", script: longScript }, { expanded: false });
    const collapsed = harness.render(100).join("\n");
    expect(collapsed).not.toContain("LAST_LINE_SENTINEL");
    harness.call({ action: "start", script: longScript }, { expanded: true });
    expect(harness.render(100).join("\n")).toContain("LAST_LINE_SENTINEL");
  });
});

describe("saved workflow discovery", () => {
  const saved = (name: string, whenToUse?: string) => ({
    name,
    scope: "project" as const,
    path: `/repo/.pi/workflows/${name}.js`,
    meta: { name, description: `Runs ${name}`, ...(whenToUse !== undefined && { whenToUse }) },
  });

  it("lists saved workflows the model can start by name, bounded", () => {
    const plain = workflowToolDescription([], memoryLocations);
    const listed = workflowToolDescription(
      [saved("review", "after large diffs"), saved("migrate")],
      memoryLocations,
    );
    expect(listed.startsWith(plain)).toBe(true);
    expect(listed).toContain("review");
    expect(listed).toContain("after large diffs");
    expect(listed).toContain("migrate");
    const many = workflowToolDescription(
      Array.from({ length: 30 }, (_, index) => saved(`flow-${index}`)),
      memoryLocations,
    );
    expect(many).toContain("flow-19");
    expect(many).not.toContain("flow-20 ");
    expect(many).toContain("10 more");
  });

  it("advertises each saved workflow's args from its meta.args schema", () => {
    const args = {
      type: "object",
      properties: { target: { type: "string" }, depth: { type: "integer" } },
      required: ["target"],
    };
    const workflow = { ...saved("review"), meta: { ...saved("review").meta, args } };
    const description = workflowToolDescription([workflow, saved("plain")], memoryLocations);
    expect(description).toContain("target: string");
    expect(description).toContain("depth?: integer");
    const listed = workflowListText(
      { workflows: [workflow], diagnostics: [], truncated: false, locations: memoryLocations },
      [],
    );
    expect(listed).toContain("target: string");
    expect(listed).toContain("depth?: integer");
  });

  it("names the session's own saved-workflow directories, the project's only when trusted", () => {
    const untrusted = workflowToolDescription([], memoryLocations);
    expect(untrusted).toContain("/agent/workflows/<name>.js");
    expect(untrusted).not.toContain("/project/.pi/workflows/<name>.js");
    const trusted = workflowToolDescription([], { ...memoryLocations, projectTrusted: true });
    expect(trusted).toContain("/project/.pi/workflows/<name>.js");
    expect(trusted).toContain("/agent/workflows/<name>.js");
  });
});
