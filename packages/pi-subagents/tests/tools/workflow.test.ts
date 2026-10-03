// Promise assertions are test-runner boundaries.
import { describe, expect, it } from "@effect/vitest";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  issueMessageStyleProblems,
} from "pi-code-previews/testing";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { beforeEach } from "vitest";
import {
  registerWorkflowTool,
  workflowToolDescription,
  type WorkflowToolRuntime,
} from "../../src/tools/workflow.ts";
import type { WorkflowToolArgs } from "../../src/tools/workflow-presentation.ts";
import {
  decodeWorkflowToolDetails,
  type WorkflowToolDetails,
} from "../../src/tools/workflow-schema.ts";
import { script, workflowFixture } from "../workflow/fixtures/workflow-harness.ts";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const renderOnly: WorkflowToolRuntime = {
  environment: { cwd: "/project", projectTrusted: false },
  run: () => Promise.reject(new Error("render-only fixture")),
};

const registeredTool = (runtime: WorkflowToolRuntime = renderOnly) => {
  const [tool] = captureRegistrations((pi) => registerWorkflowTool(pi, runtime)).tools;
  return tool!;
};

/** The registered tool over the real workflow and subagent services. */
const liveTool = () => {
  const fixture = workflowFixture();
  const runtime = ManagedRuntime.make(Layer.merge(fixture.layer, fixture.backend.layer));
  const tool = registeredTool({
    environment: { cwd: "/project", projectTrusted: false },
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
  return { execute, dispose: Effect.promise(() => runtime.dispose()) };
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

  it.live("returns plain-sentence issues for calls that can't run", () =>
    Effect.gen(function* () {
      const { execute, dispose } = liveTool();
      const rejected = [
        yield* execute({ action: "start", script: script("return 1;"), name: "saved" }),
        yield* execute({ action: "start", script: script("return (;") }),
        yield* execute({ action: "start", script: "return 1;" }),
        yield* execute({ action: "start", name: "missing" }),
        yield* execute({ action: "status", runId: "wf-unknown-1" }),
        yield* execute({ action: "start", script: script("return 1;"), resumeFromRunId: "wf-x-9" }),
        yield* execute({ action: "status" }),
      ];
      for (const result of rejected) {
        expect(result.isError).toBe(true);
        const issue = detailsOf(result).issue!;
        expect(
          issueMessageStyleProblems(issue.message, { forbidden: ["wf-unknown-1", "wf-x-9"] }),
          issue.message,
        ).toEqual([]);
        // The agent keeps the full explanation.
        expect(textOf(result).length).toBeGreaterThan(issue.message.length);
      }
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
    const plain = workflowToolDescription([]);
    const listed = workflowToolDescription([
      saved("review", "after large diffs"),
      saved("migrate"),
    ]);
    expect(listed.startsWith(plain)).toBe(true);
    expect(listed).toContain("review");
    expect(listed).toContain("after large diffs");
    expect(listed).toContain("migrate");
    const many = workflowToolDescription(
      Array.from({ length: 30 }, (_, index) => saved(`flow-${index}`)),
    );
    expect(many).toContain("flow-19");
    expect(many).not.toContain("flow-20 ");
    expect(many).toContain("10 more");
  });
});
