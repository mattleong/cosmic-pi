import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import * as Effect from "effect/Effect";
import { assert, describe, expect, it } from "vitest";
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
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

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
  createSubagentCompactSummary("agent_worktree")({
    phase: "settled",
    args,
    result,
    context: renderContextFixture({ isError: false }),
  });

const resultText = (result: AgentToolResult<WorkspaceToolDetails>) =>
  Arr.join(
    Arr.map(result.content, (part) => (part.type === "text" ? part.text : "")),
    "\n",
  );

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
  leaseReleaseUnconfirmed: false,
} as const;

const applied = (overrides: Partial<WorkspaceApplyResult> = {}): WorkspaceApplyResult => ({
  revisionId: "rev-1",
  preparationId: "prep-1",
  preparedCwd: "/agent/ws-1/prepared",
  changedPaths: ["src/a.ts", "src/b.ts"],
  changedPathCount: 2,
  leftOutPaths: [],
  ...integrated,
  testing: "untested",
  ...overrides,
});

describe("workspace apply", () => {
  effectTest("requires a workspace and refuses review paging", function* () {
    for (const operation of [
      { action: "apply" },
      { action: "apply", workspaceId: "ws-1", offset: 1 },
    ] as const) {
      const failed = yield* run(operation).pipe(Effect.flip, Effect.orDie);
      expect(failed).toMatchObject({ code: "workspace_input_invalid" });
    }
  });

  effectTest("forwards the caller and the optional revision pin", function* () {
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
    ] as const)
      yield* run(operation, "parent", { workspaceApply }).pipe(Effect.orDie);
    expect(calls).toEqual([
      ["ws-1", { revisionId: undefined }, "parent"],
      ["ws-1", { revisionId: "rev-1" }, "parent"],
    ]);
  });

  effectTest("reports the parent's own preparation as tested by the parent", function* () {
    const args = { action: "apply", workspaceId: "ws-1" } as const;
    const result = yield* run(args, "parent", {
      workspaceApply: () => Effect.succeed(applied({ testing: "parent-tested" })),
    }).pipe(Effect.orDie);
    expect(result.details).toMatchObject({
      operation: "apply",
      preparationId: "prep-1",
      testing: "parent-tested",
    });
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("success");
    assert(summary?.issues !== undefined);
    expect(Arr.map(summary.issues, (issue) => issue.code)).not.toContain("applied-untested");
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
          leftOutPaths: leftOut,
        }),
    };
    for (const args of [applyArgs, prepareArgs]) {
      const result = yield* run(args, "parent", service).pipe(Effect.orDie);
      for (const name of leftOut) expect(resultText(result)).toContain(name);
      const summary = summarize(args, result);
      expect(summary?.outcome).toBe("warning");
      assert(summary?.issues !== undefined);
      expect(
        Arr.map(
          Arr.filter(summary.issues, (issue) => issue.severity === "warning"),
          (issue) => issue.code,
        ),
      ).toEqual(["credential-files-left-out"]);
      expectStyledIssues(summary);
    }
  });

  effectTest("reports whether an applied change was tested", function* () {
    const cases = [
      [applied(), "untested"],
      [applied({ testing: "parent-tested" }), "parent-tested"],
    ] as const;
    for (const [outcome, testing] of cases) {
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
        testing,
      });
      expect(resultText(result)).toContain("src/b.ts");
      const summary = summarize(args, result);
      expect(summary?.outcome).toBe("success");
      expectStyledIssues(summary);
    }
  });

  effectTest("warns about every integration leftover the apply leaves behind", function* () {
    const args = { action: "apply", workspaceId: "ws-1" } as const;
    const result = yield* run(args, "parent", {
      workspaceApply: () =>
        Effect.succeed(
          applied({
            untouchedDriftPaths: ["src/notes.md"],
            treeRemovalFailed: true,
            leaseReleaseUnconfirmed: true,
          }),
        ),
    }).pipe(Effect.orDie);
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    assert(summary?.issues !== undefined);
    expect(Arr.filter(summary.issues, (issue) => issue.severity === "warning")).toHaveLength(3);
    expectStyledIssues(summary);
  });
});

describe("workspace refusals", () => {
  it.each(["apply", "revise"])("renders any refusal of %s as one error", (action) => {
    const summary = createSubagentCompactSummary("agent_worktree")({
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
    assert(summary?.issues !== undefined);
    expect(Arr.filter(summary.issues, (issue) => issue.severity === "error")).toHaveLength(1);
    expectStyledIssues(summary);
  });
});

const orphan = (workspaceId: string, status: "active" | "integrating" = "active") => ({
  version: 2 as const,
  repository: "/repo/.git",
  handle: {
    workspaceId,
    ownerId: "ended-session/root",
    sourceCwd: "/project",
    sourceRoot: "/project",
    artifactRoot: `/agent/${workspaceId}`,
    cwd: `/agent/${workspaceId}/worker`,
  },
  status,
  baseline: "abc",
  ownerLease: "ended-owner",
  lastChangedAt: 0,
});

describe("workspace list", () => {
  effectTest("warns that unreadable records leave ownership and cleanup unknown", function* () {
    const args = { action: "list" } as const;
    const result = yield* run(args, undefined, {
      workspaceList: () =>
        Effect.succeed({
          records: [orphan("ws-1")],
          unavailable: [
            { workspaceId: "ws-3", status: "unavailable", reason: "recovery-record-unavailable" },
          ],
        }),
    }).pipe(Effect.orDie);
    expect(resultText(result)).toContain("recovery-record-unavailable");
    expect(result.details).toMatchObject({ workspaceCount: 2, unavailableCount: 1 });
    const summary = summarize(args, result);
    expect(summary?.outcome).toBe("warning");
    assert(summary?.issues !== undefined);
    expect(Arr.map(summary.issues, (issue) => issue.code)).toContain(
      "workspace-records-unavailable",
    );
    expectStyledIssues(summary);
  });

  effectTest("marks orphans the root may adopt or only discard", function* () {
    const args = { action: "list" } as const;
    const result = yield* run(args, undefined, {
      workspaceList: () =>
        Effect.succeed({
          records: [orphan("ws-1"), orphan("ws-2", "integrating")],
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
    assert(summary?.issues !== undefined);
    expect(Arr.map(summary.issues, (issue) => issue.code)).toContain("orphans-adoptable");
    expectStyledIssues(summary);
  });
});

describe("workspace tool", () => {
  effectTest(
    "returns complete immutable pages without persisting patches in details",
    function* () {
      const diff = "diff --git a/file b/file\n" + Fn.pipe("content\n", Str.repeat(3_000));
      const service = {
        workspaceReview: (
          workspaceId: string,
          options: { revisionId?: string; offset?: number } = {},
          caller?: string,
        ) => {
          expect(caller).toBe("parent");
          expect(workspaceId).toBe("workspace");
          if (options.offset) expect(options.revisionId).toBe("immutable");
          const offset = options.offset ?? 0;
          const next = Math.min(diff.length, offset + 16_000);
          return Effect.succeed({
            revisionId: "immutable",
            changedPaths: ["file"],
            text: Fn.pipe(diff, Str.slice(offset, next)),
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
        [first, Fn.pipe(diff, Str.slice(0, 16_000))],
        [second, Fn.pipe(diff, Str.slice(16_000))],
      ] as const) {
        const content = page.content[0];
        const span = page.details.displayContent!;
        expect(
          content?.type === "text" &&
            Fn.pipe(content.text, Str.slice(span.offset, span.offset + span.length)),
        ).toBe(expected);
      }
      expect(JSON.stringify(first.details)).not.toContain("content");
      expect(JSON.stringify(second.details)).not.toContain("content");
    },
  );

  effectTest(
    "passes the authenticated caller and the revision pin to the coordinator",
    function* () {
      const denial = InvalidSubagentRequestError.make({
        code: "workspace_owner_unavailable",
        message: "Direct parent required.",
      });
      const failed = yield* run({ action: "apply", workspaceId: "w", revisionId: "r" }, "child", {
        workspaceApply: (workspaceId, options, caller) => {
          expect([workspaceId, options, caller]).toEqual(["w", { revisionId: "r" }, "child"]);
          return Effect.fail(denial);
        },
      }).pipe(Effect.flip, Effect.orDie);
      expect(failed).toBe(denial);
    },
  );
});
