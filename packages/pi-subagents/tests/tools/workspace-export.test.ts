import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import { describe, expect } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { SubagentService } from "../../src/run/service.ts";
import type { WorkspaceApplyResult } from "../../src/run/workspace-apply.ts";
import type { WorkspaceExportResult } from "../../src/run/workspace-export.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import type { WorkspaceToolDetails } from "../../src/tools/details-schema.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import { view } from "../fixtures/run-view.ts";
import {
  subagentServiceDouble,
  type SubagentServiceDoubleInput,
} from "./fixtures/subagent-service-double.ts";

type Operation = Parameters<typeof executeWorkspaceAction>[0];

const run = (operation: Operation, overrides: SubagentServiceDoubleInput = {}) =>
  executeWorkspaceAction(operation, "parent").pipe(
    Effect.provideService(SubagentService, subagentServiceDouble(overrides)),
  );

const summarize = (args: Operation, result: AgentToolResult<WorkspaceToolDetails>) =>
  createSubagentCompactSummary("subagent_workspace")({
    phase: "settled",
    args,
    result,
    context: renderContextFixture({ isError: false }),
  });

const resultText = (result: AgentToolResult<WorkspaceToolDetails>) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

const expectStyledIssues = (summary: ReturnType<typeof summarize>) => {
  expect(summary?.issues?.length).toBeGreaterThan(0);
  for (const issue of summary?.issues ?? [])
    expect(
      issueMessageStyleProblems(issue.message, { forbidden: ["ws-1"] }),
      issue.message,
    ).toEqual([]);
};

const patchExport: WorkspaceExportResult = {
  format: "patch",
  path: "/repo/.git/pi-subagents/ws-1-rev-1.patch",
  revisionId: "rev-1",
  changedPaths: ["src/a.ts", "src/b.ts"],
  uncapturedPaths: ["dist/out.js", "bad:name.ts"],
  orphan: false,
};

describe("workspace input", () => {
  effectTest("accepts each new field only with its own action", function* () {
    const operations: ReadonlyArray<Operation> = [
      { action: "export", workspaceId: "ws-1", paths: ["src/a.ts"] },
      { action: "apply", workspaceId: "ws-1", format: "patch" },
      {
        action: "apply",
        workspaceId: "ws-1",
        revisionId: "rev-1",
        preparationId: "prep-1",
        paths: ["src/a.ts"],
      },
      { action: "revise", workspaceId: "ws-1", message: "Again.", format: "branch" },
      { action: "review", workspaceId: "ws-1", rebase: true },
    ];
    for (const operation of operations) {
      const failed = yield* run(operation).pipe(Effect.flip, Effect.orDie);
      expect(failed).toMatchObject({ code: "workspace_input_invalid" });
    }
  });
});

describe("workspace export", () => {
  effectTest("forwards the pin and format and names the patch file", function* () {
    const calls: unknown[] = [];
    const args = { action: "export", workspaceId: "ws-1", revisionId: "rev-1" } as const;
    const result = yield* run(args, {
      workspaceExport: (workspaceId, options, caller) => {
        calls.push([workspaceId, options, caller]);
        return Effect.succeed(patchExport);
      },
    }).pipe(Effect.orDie);
    expect(calls).toEqual([["ws-1", { revisionId: "rev-1" }, "parent"]]);
    expect(resultText(result)).toContain(patchExport.path);
    expect(result.details).toMatchObject({
      operation: "export",
      revisionId: "rev-1",
      changedPathCount: 2,
      exportFormat: "patch",
      exportPath: patchExport.path,
    });
    expect(result.details.warnings?.map((warning) => warning.code)).toEqual([
      "worker-files-left-out",
      "uncaptured-files-not-exported",
    ]);
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    expect(summary?.counters).toHaveLength(1);
    expectStyledIssues(summary);
  });

  effectTest("names an orphan's exported branch without warnings", function* () {
    const args = { action: "export", workspaceId: "ws-1", format: "branch" } as const;
    const result = yield* run(args, {
      workspaceExport: () =>
        Effect.succeed({
          format: "branch",
          branch: "pi-subagent/token-parser",
          commit: "c".repeat(40),
          base: "b".repeat(40),
          revisionId: "rev-1",
          changedPaths: ["src/a.ts"],
          uncapturedPaths: [],
          identity: "user",
          orphan: true,
        }),
    }).pipe(Effect.orDie);
    expect(resultText(result)).toContain("pi-subagent/token-parser");
    expect(result.details).toMatchObject({
      exportFormat: "branch",
      exportBranch: "pi-subagent/token-parser",
    });
    expect(result.details.warnings).toBeUndefined();
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("success");
    expect(summary?.counters).toHaveLength(1);
  });

  effectTest("warns when the branch commit fell back to the placeholder identity", function* () {
    const args = { action: "export", workspaceId: "ws-1", format: "branch" } as const;
    const result = yield* run(args, {
      workspaceExport: () =>
        Effect.succeed({
          format: "branch",
          branch: "pi-subagent/token-parser",
          commit: "c".repeat(40),
          base: "b".repeat(40),
          revisionId: "rev-1",
          changedPaths: ["src/a.ts"],
          uncapturedPaths: [],
          identity: "placeholder",
          orphan: false,
        }),
    }).pipe(Effect.orDie);
    expect(result.details.warnings?.map((warning) => warning.code)).toEqual([
      "export-placeholder-identity",
    ]);
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    expectStyledIssues(summary);
  });
});

describe("partial apply", () => {
  effectTest("forwards paths and reports what stays in the workspace", function* () {
    const args: Operation = { action: "apply", workspaceId: "ws-1", paths: ["src/a.ts"] };
    const calls: unknown[] = [];
    const partial: WorkspaceApplyResult = {
      revisionId: "rev-1",
      preparationId: "prep-1",
      preparedCwd: "/agent/ws-1/prepared",
      changedPaths: ["src/a.ts"],
      changedPathCount: 1,
      remainingPaths: ["src/b.ts", "src/c.ts"],
      remainingPathCount: 2,
      leftOutPaths: [],
      reviewed: false,
      workerRoot: "/agent/ws-1/worker",
      untouchedDriftPaths: [],
      treeRemovalFailed: false,
      remainingBackupPaths: [],
      leaseReleaseUnconfirmed: false,
      integrated: true,
      verification: { status: "not-configured" },
    };
    const result = yield* run(args, {
      workspaceApply: (workspaceId, options) => {
        calls.push([workspaceId, options]);
        return Effect.succeed(partial);
      },
    }).pipe(Effect.orDie);
    expect(calls).toEqual([["ws-1", { paths: ["src/a.ts"] }]]);
    const text = resultText(result);
    for (const remaining of partial.remainingPaths ?? []) expect(text).toContain(remaining);
    expect(result.details).toMatchObject({ changedPathCount: 1, remainingPathCount: 2 });
    const summary = summarize(args, result);
    expect(summary?.issues?.map((issue) => issue.code)).toContain("remaining-proposal");
    expectStyledIssues(summary);
  });
});

describe("rebasing revise", () => {
  effectTest("forwards rebase and warns about conflicts the successor must resolve", function* () {
    const args = {
      action: "revise",
      workspaceId: "ws-1",
      message: "Use the new API.",
      rebase: true,
    } as const;
    const calls: unknown[] = [];
    const result = yield* run(args, {
      workspaceRevise: (workspaceId, message, caller, options) => {
        calls.push([workspaceId, message, caller, options]);
        return Effect.succeed({
          run: view({ id: "agent-2", writeIntent: "writer" }),
          rebase: { reappliedPaths: ["src/a.ts", "src/b.ts"], conflictedPaths: ["src/a.ts"] },
        });
      },
    }).pipe(Effect.orDie);
    expect(calls).toEqual([["ws-1", "Use the new API.", "parent", { rebase: true }]]);
    expect(resultText(result)).toContain('"src/a.ts"');
    expect(result.details).toMatchObject({
      successorRunId: "agent-2",
      rebased: true,
      conflictCount: 1,
    });
    const summary = summarize(args, result);
    expect(summary?.counters).toHaveLength(1);
    expect(summary?.issues?.map((issue) => issue.code)).toEqual([
      "revision-invalidated",
      "rebase-conflicts",
    ]);
    expectStyledIssues(summary);
  });
});
