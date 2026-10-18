import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import type { WorkspaceApplyResult } from "../../src/run/workspace-apply.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import type { WorkspaceToolDetails } from "../../src/tools/details-schema.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import {
  subagentServiceDouble,
  type SubagentServiceDoubleInput,
} from "./fixtures/subagent-service-double.ts";

const run = (
  operation: Parameters<typeof executeWorkspaceAction>[0],
  caller?: string,
  overrides: SubagentServiceDoubleInput = {},
) =>
  executeWorkspaceAction(operation, caller).pipe(
    Effect.provideService(SubagentService, subagentServiceDouble(overrides)),
  );

const summarize = (
  args: Parameters<typeof executeWorkspaceAction>[0],
  result: AgentToolResult<WorkspaceToolDetails>,
) =>
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

const integrated = {
  workerRoot: "/agent/ws-1/worker",
  untouchedDriftPaths: [],
  treeRemovalFailed: false,
  remainingBackupPaths: [],
  leaseReleaseUnconfirmed: false,
} as const;

const applied = (
  overrides: Partial<Extract<WorkspaceApplyResult, { readonly integrated: true }>> = {},
): WorkspaceApplyResult => ({
  revisionId: "rev-1",
  preparationId: "prep-1",
  preparedCwd: "/agent/ws-1/prepared",
  changedPaths: ["src/a.ts", "src/b.ts"],
  changedPathCount: 2,
  leftOutPaths: [],
  reviewed: false,
  ...integrated,
  integrated: true,
  verification: { status: "not-configured" },
  ...overrides,
});

const verificationOutput = [
  "EARLY_OUTPUT_SENTINEL",
  ...Array.from({ length: 30 }, (_, index) => `line ${index}`),
  "FINAL_OUTPUT_SENTINEL",
].join("\n");

const failedVerification: WorkspaceApplyResult = {
  revisionId: "rev-1",
  preparationId: "prep-1",
  preparedCwd: "/agent/ws-1/prepared",
  changedPaths: ["src/a.ts"],
  changedPathCount: 1,
  leftOutPaths: [],
  reviewed: true,
  integrated: false,
  verification: {
    status: "failed",
    command: ["pnpm", "test"],
    outputTail: verificationOutput,
    message: `Verification exited with code 1: ${"x".repeat(5_000)}`,
  },
  nextSteps: "NEXT_STEPS_SENTINEL",
};

describe("workspace apply", () => {
  effectTest("requires a workspace, and a preparation only with its exact revision", function* () {
    for (const operation of [
      { action: "apply" },
      { action: "apply", workspaceId: "ws-1", preparationId: "prep-1" },
      { action: "apply", workspaceId: "ws-1", offset: 1 },
    ] as const) {
      const failed = yield* run(operation).pipe(Effect.flip, Effect.orDie);
      expect(failed).toMatchObject({ code: "workspace_input_invalid" });
    }
  });

  effectTest("forwards the caller, the optional revision pin, and a prepared pair", function* () {
    const calls: Array<readonly [string, unknown, string | undefined]> = [];
    const workspaceApply: SubagentServiceDoubleInput["workspaceApply"] = (
      workspaceId,
      options,
      caller,
    ) => {
      calls.push([workspaceId, options, caller]);
      return Effect.succeed(applied());
    };
    for (const operation of [
      { action: "apply", workspaceId: "ws-1" },
      { action: "apply", workspaceId: "ws-1", revisionId: "rev-1" },
      { action: "apply", workspaceId: "ws-1", revisionId: "rev-1", preparationId: "prep-1" },
    ] as const)
      yield* run(operation, "parent", { workspaceApply }).pipe(Effect.orDie);
    expect(calls).toEqual([
      ["ws-1", { revisionId: undefined }, "parent"],
      ["ws-1", { revisionId: "rev-1" }, "parent"],
      ["ws-1", { revisionId: "rev-1", preparationId: "prep-1" }, "parent"],
    ]);
  });

  effectTest("reports a prepared pair as tested by the parent, not verified", function* () {
    const args = {
      action: "apply",
      workspaceId: "ws-1",
      revisionId: "rev-1",
      preparationId: "prep-1",
    } as const;
    const result = yield* run(args, "parent", {
      workspaceApply: () =>
        Effect.succeed(applied({ reviewed: true, verification: { status: "parent-tested" } })),
    }).pipe(Effect.orDie);
    expect(result.details).toMatchObject({
      operation: "apply",
      preparationId: "prep-1",
      reviewed: true,
      verification: "parent-tested",
    });
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("success");
    expect(summary?.issues?.map((issue) => issue.code)).not.toContain("applied-unverified");
    expectStyledIssues(summary);
  });

  effectTest("warns about credential files left out of the proposal on purpose", function* () {
    const leftOut = [".env", "certs/dev.pem"];
    const applyArgs = { action: "apply", workspaceId: "ws-1" } as const;
    const prepareArgs = { action: "prepare", workspaceId: "ws-1", revisionId: "rev-1" } as const;
    const service: SubagentServiceDoubleInput = {
      workspaceApply: () => Effect.succeed(applied({ leftOutPaths: leftOut })),
      workspacePrepare: () =>
        Effect.succeed({
          preparationId: "prep-1",
          revisionId: "rev-1",
          cwd: "/agent/ws-1/prepared",
          leaseDirectories: [],
          leftOutPaths: leftOut,
        }),
    };
    for (const args of [applyArgs, prepareArgs]) {
      const result = yield* run(args, "parent", service).pipe(Effect.orDie);
      for (const name of leftOut) expect(resultText(result)).toContain(name);
      const summary = summarize(args, result);
      expect(summary?.outcome).toBe("warning");
      expect(
        summary?.issues?.filter((issue) => issue.severity === "warning").map((issue) => issue.code),
      ).toEqual(["credential-files-left-out"]);
      expectStyledIssues(summary);
    }
  });

  effectTest("reports whether an applied change was reviewed and verified", function* () {
    const passed = applied({
      reviewed: true,
      verification: { status: "passed", command: ["pnpm", "test"], outputTail: verificationOutput },
    });
    const cases = [
      [applied(), false, "not-configured"],
      [passed, true, "passed"],
    ] as const;
    for (const [outcome, reviewed, verification] of cases) {
      const args = { action: "apply", workspaceId: "ws-1" } as const;
      const result = yield* run(args, "parent", {
        workspaceApply: () => Effect.succeed(outcome),
      }).pipe(Effect.orDie);
      expect(result.details).toMatchObject({
        operation: "apply",
        workspaceId: "ws-1",
        revisionId: "rev-1",
        preparationId: "prep-1",
        changedPathCount: 2,
        reviewed,
        verification,
      });
      expect(resultText(result)).toContain("src/b.ts");
      const summary = summarize(args, result);
      expect(summary?.outcome).toBe("success");
      expectStyledIssues(summary);
      expect(JSON.stringify(result.details)).not.toContain("SENTINEL");
    }
  });

  effectTest(
    "blocks a failed verification as an error that keeps the evidence out of details",
    function* () {
      const args = { action: "apply", workspaceId: "ws-1" } as const;
      const result = yield* run(args, "parent", {
        workspaceApply: () => Effect.succeed(failedVerification),
      }).pipe(Effect.orDie);
      expect(result.details).toMatchObject({ operation: "apply", verification: "failed" });
      expect(result.details.warnings).toBeUndefined();
      expect(result.details.verificationMessage?.length).toBeLessThanOrEqual(512);
      expect(JSON.stringify(result.details)).not.toMatch(/SENTINEL/u);
      const text = resultText(result);
      for (const evidence of ["EARLY_OUTPUT_SENTINEL", "FINAL_OUTPUT_SENTINEL", "NEXT_STEPS"])
        expect(text).toContain(evidence);
      expect(text).toContain(failedVerification.preparedCwd);
      const span = result.details.displayContent!;
      expect(text.slice(span.offset, span.offset + span.length)).toContain("FINAL_OUTPUT_SENTINEL");
      const summary = summarize(args, result);
      expect(summary?.outcome).toBe("error");
      expect(summary?.issues?.filter((issue) => issue.severity === "error")).toHaveLength(1);
      expectStyledIssues(summary);
    },
  );

  effectTest("warns about every integration leftover the apply leaves behind", function* () {
    const args = { action: "apply", workspaceId: "ws-1" } as const;
    const result = yield* run(args, "parent", {
      workspaceApply: () =>
        Effect.succeed(
          applied({
            untouchedDriftPaths: ["src/notes.md"],
            treeRemovalFailed: true,
            remainingBackupPaths: ["/project/.backup"],
            leaseReleaseUnconfirmed: true,
          }),
        ),
    }).pipe(Effect.orDie);
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues?.filter((issue) => issue.severity === "warning")).toHaveLength(4);
    expectStyledIssues(summary);
  });
});

describe("workspace refusals", () => {
  it.each(["apply", "revise"])("renders any refusal of %s as one error", (action) => {
    const summary = createSubagentCompactSummary("subagent_workspace")({
      phase: "settled",
      args: { action, workspaceId: "ws-1" },
      result: {
        content: [
          {
            type: "text",
            text: "Child workspaces of this workspace are still unresolved; integrate or discard them first.",
          },
        ],
        details: undefined,
      },
      context: renderContextFixture({ isError: true }),
    });
    expect(summary?.outcome).toBe("error");
    expect(summary?.issues?.filter((issue) => issue.severity === "error")).toHaveLength(1);
    expectStyledIssues(summary);
  });
});

const orphan = (workspaceId: string, sourceWorkspaceId?: string) => ({
  version: 2 as const,
  repository: "/repo/.git",
  handle: {
    workspaceId,
    ownerId: "ended-session/root",
    sourceCwd: "/project",
    sourceRoot: "/project",
    cwd: `/agent/${workspaceId}/worker`,
    ...(sourceWorkspaceId !== undefined && { sourceWorkspaceId, checkoutRoot: "/project" }),
  },
  status: "active" as const,
  baseline: "abc",
});

describe("workspace prepared-pair apply and list", () => {
  effectTest("warns when unresolved child workspaces keep the worker tree", function* () {
    const args = {
      action: "apply",
      workspaceId: "ws-1",
      revisionId: "rev-1",
      preparationId: "prep-1",
    } as const;
    const result = yield* run(args, "parent", {
      workspaceApply: () =>
        Effect.succeed(
          applied({
            reviewed: true,
            verification: { status: "parent-tested" },
            retainedForChildren: ["ws-child-1", "ws-child-2"],
          }),
        ),
    }).pipe(Effect.orDie);
    expect(resultText(result)).toContain("ws-child-2");
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues?.some((issue) => issue.detail?.includes("ws-child-1"))).toBe(true);
    expectStyledIssues(summary);
  });

  effectTest("names nested sources and unresolvable source chains", function* () {
    const args = { action: "list" } as const;
    const result = yield* run(args, "parent", {
      workspaceList: () =>
        Effect.succeed({
          records: [
            {
              version: 2,
              repository: "/repo/.git",
              handle: {
                workspaceId: "ws-2",
                ownerId: "root",
                sourceCwd: "/agent/ws-1/worker",
                sourceRoot: "/agent/ws-1/worker",
                cwd: "/agent/ws-2/worker",
                sourceWorkspaceId: "ws-1",
                checkoutRoot: "/project",
              },
              status: "active",
              baseline: "abc",
            },
          ],
          unavailable: [
            { workspaceId: "ws-3", status: "unavailable", reason: "source-workspace-unavailable" },
          ],
        }),
    }).pipe(Effect.orDie);
    const text = resultText(result);
    expect(text).toContain('"sourceWorkspaceId":"ws-1"');
    expect(text).toContain("source-workspace-unavailable");
    expect(result.details).toMatchObject({ unavailableCount: 1, sourceUnavailableCount: 1 });
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues?.map((issue) => issue.code)).not.toContain(
      "workspace-records-unavailable",
    );
    expectStyledIssues(summary);
  });

  effectTest("marks orphans the root may adopt or only discard", function* () {
    const args = { action: "list" } as const;
    const result = yield* run(args, undefined, {
      workspaceList: () =>
        Effect.succeed({
          records: [orphan("ws-1"), orphan("ws-2", "ws-1")],
          unavailable: [],
          orphans: new Map([
            ["ws-1", "adoptable" as const],
            ["ws-2", "discard-only" as const],
          ]),
        }),
    }).pipe(Effect.orDie);
    const text = resultText(result);
    expect(text).toContain('"workspaceId":"ws-1"');
    expect(text).toContain('"orphan":"adoptable"');
    expect(text).toContain('"orphan":"discard-only"');
    expect(result.details).toMatchObject({ adoptableCount: 1 });
    const summary = summarize(args, result);
    expect(summary?.issues?.map((issue) => issue.code)).toContain("orphans-adoptable");
    expectStyledIssues(summary);
  });
});

describe("workspace tool", () => {
  effectTest(
    "returns complete immutable pages without persisting patches in details",
    function* () {
      const diff = "diff --git a/file b/file\n" + "content\n".repeat(3_000);
      const service = {
        workspaceReview: (
          workspaceId: string,
          options: { revisionId?: string; offset?: number; limit?: number } = {},
          caller?: string,
        ) => {
          expect(caller).toBe("parent");
          expect(workspaceId).toBe("workspace");
          if (options.offset) expect(options.revisionId).toBe("immutable");
          const offset = options.offset ?? 0;
          const next = Math.min(diff.length, offset + (options.limit ?? 16_000));
          return Effect.succeed({
            revisionId: "immutable",
            changedPaths: ["file"],
            text: diff.slice(offset, next),
            offset,
            totalChars: diff.length,
            ...(next < diff.length && { nextOffset: next }),
          });
        },
      };
      const first = yield* run(
        { action: "review", workspaceId: "workspace" },
        "parent",
        service,
      ).pipe(Effect.orDie);
      expect(first.details).toMatchObject({
        revisionId: "immutable",
        offset: 0,
        totalChars: diff.length,
        nextOffset: 16_000,
      });
      const second = yield* run(
        { action: "review", workspaceId: "workspace", revisionId: "immutable", offset: 16_000 },
        "parent",
        service,
      ).pipe(Effect.orDie);
      for (const [page, expected] of [
        [first, diff.slice(0, 16_000)],
        [second, diff.slice(16_000)],
      ] as const) {
        const content = page.content[0];
        const span = page.details.displayContent!;
        expect(
          content?.type === "text" && content.text.slice(span.offset, span.offset + span.length),
        ).toBe(expected);
      }
      expect(JSON.stringify(first.details)).not.toContain("content");
      expect(JSON.stringify(second.details)).not.toContain("content");
    },
  );

  effectTest(
    "passes authenticated caller and exact tested identifiers to the coordinator",
    function* () {
      const denial = new InvalidSubagentRequestError({
        code: "workspace_owner_unavailable",
        message: "Direct parent required.",
      });
      const failed = yield* run(
        { action: "apply", workspaceId: "w", revisionId: "r", preparationId: "p" },
        "child",
        {
          workspaceApply: (workspaceId, options, caller) => {
            expect([workspaceId, options, caller]).toEqual([
              "w",
              { revisionId: "r", preparationId: "p" },
              "child",
            ]);
            return Effect.fail(denial);
          },
        },
      ).pipe(Effect.flip, Effect.orDie);
      expect(failed).toBe(denial);
    },
  );
});
