import { describe, expect, it } from "vitest";
import * as Exit from "effect/Exit";
import type { WorkflowSandboxOutcome } from "../../src/boundary/codemode-sandbox.ts";
import type { WorkflowRunView } from "../../src/workflow/model.ts";
import { workflowStatusText } from "../../src/tools/workflow-format.ts";
import { workflowNotification } from "../../src/workflow/notification.ts";
import { WORKFLOW_BUDGET_ERROR } from "../../src/workflow/prelude.ts";
import { concludeWorkflow, finishWorkflowRun } from "../../src/workflow/state.ts";
import { workflowRunView } from "../fixtures/run-view.ts";

const failedRun = (
  kind: Extract<WorkflowSandboxOutcome, { _tag: "Failed" }>["kind"],
  name = "Error",
  patch: Partial<WorkflowRunView> = {},
) =>
  finishWorkflowRun(
    workflowRunView(patch),
    concludeWorkflow(
      Exit.succeed({
        _tag: "Failed",
        kind,
        failure: { name, message: "Cannot find module worker.js", stack: "at workflow:4" },
        output: ["partial output"],
      }),
    ),
    undefined,
    10,
  );

const recoverySurfaces = (run: WorkflowRunView) => [
  workflowStatusText(run, 10),
  workflowNotification(run)!.content,
];

describe("workflow failure recovery", () => {
  const sources: Array<Partial<WorkflowRunView>> = [
    { source: { kind: "saved", name: "audit", scope: "user", path: "/workflows/audit.js" } },
    { source: { kind: "file", path: "/scripts/audit.js" } },
    { source: { kind: "inline" }, scriptPath: "/runs/script.js" },
    { source: { kind: "inline" } },
  ];
  for (const source of sources) {
    it(`recommends runtime recovery for ${source.source?.kind} with ${source.scriptPath ?? "original source"}`, () => {
      const run = failedRun("sandbox", "Error", source);
      expect(run.failure).toMatchObject({ kind: "sandbox", name: "Error" });
      expect(run.logs.at(-1)?.message).toBe("partial output");
      for (const text of recoverySurfaces(run)) {
        expect(text).toMatch(/restart Pi/i);
        expect(text).toContain("same args");
        expect(text).toContain("unchanged workflow");
        expect(text).toContain(`resumeFromRunId: "${run.id}"`);
        expect(text).toContain("Cannot find module worker.js");
        expect(text).toContain("at workflow:4");
        expect(text).not.toMatch(/fix the script|with your file tools/i);
        if (run.source.kind === "saved") expect(text).toContain('name: "audit"');
        if (run.source.kind === "file") expect(text).toContain(`scriptPath: "${run.source.path}"`);
        if (run.scriptPath) expect(text).toContain(`scriptPath: "${run.scriptPath}"`);
      }
    });
  }

  for (const kind of ["script", "timeout"] as const) {
    it(`does not infer a runtime failure from the ${kind} error's name or message`, () => {
      const run = failedRun(kind, "SandboxError");
      expect(run.failure?.kind).toBe(kind);
      for (const text of recoverySurfaces(run)) {
        expect(text).toMatch(/fix the script/i);
        expect(text).not.toMatch(/restart Pi/i);
      }
    });
  }

  it("preserves legacy script recovery and budget consent", () => {
    const legacy = { ...failedRun("script"), failure: { message: "old failure" } };
    for (const text of recoverySurfaces(legacy)) expect(text).toMatch(/fix the script/i);
    for (const text of recoverySurfaces(failedRun("script", WORKFLOW_BUDGET_ERROR))) {
      expect(text).toContain("ask the user");
      expect(text).toContain("budget.remaining()");
    }
    // Foreign names must not override an explicitly classified infrastructure failure.
    for (const text of recoverySurfaces(failedRun("sandbox", WORKFLOW_BUDGET_ERROR))) {
      expect(text).toMatch(/restart Pi/i);
      expect(text).not.toContain("budget.remaining()");
    }
  });

  it("treats runner defects as infrastructure and aborts as stopped", () => {
    const run = finishWorkflowRun(
      workflowRunView(),
      concludeWorkflow(Exit.die(new Error("runner unavailable"))),
      undefined,
      10,
    );
    expect(run.failure?.kind).toBe("runner");
    for (const text of recoverySurfaces(run)) expect(text).toMatch(/restart Pi/i);
    const stopped = failedRun("aborted");
    expect(stopped.state).toBe("stopped");
    expect(stopped.failure).toBeUndefined();
    for (const text of recoverySurfaces(stopped)) expect(text).not.toMatch(/restart Pi/i);
  });
});
