import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { describe, expect } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import type { WorkspaceIntegrationOutcome } from "../../src/run/workspace-integration.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import { compactWorkspaceSummary } from "../../src/tools/compact-workspace-summary.ts";
import type { WorkspaceRecord } from "../../src/workspace/model.ts";
import {
  subagentServiceDouble,
  type SubagentServiceDoubleInput,
} from "./fixtures/subagent-service-double.ts";

/** Runs one workspace action against a service double with only `overrides` implemented. */
const run = (
  operation: Parameters<typeof executeWorkspaceAction>[0],
  caller?: string,
  overrides: SubagentServiceDoubleInput = {},
) =>
  executeWorkspaceAction(operation, caller).pipe(
    Effect.provideService(SubagentService, subagentServiceDouble(overrides)),
  );

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
            diff: diff.slice(offset, next),
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
        { action: "integrate", workspaceId: "w", revisionId: "r", preparationId: "p" },
        "child",
        {
          workspaceIntegrate: (workspaceId, revisionId, preparationId, caller) => {
            expect([workspaceId, revisionId, preparationId, caller]).toEqual([
              "w",
              "r",
              "p",
              "child",
            ]);
            return Effect.fail(denial);
          },
        },
      ).pipe(Effect.flip, Effect.orDie);
      expect(failed).toBe(denial);
    },
  );

  effectTest("persists bounded empty-list counts without changing orphan guidance", function* () {
    const response = yield* run({ action: "list" }, undefined, {
      workspaceList: () => Effect.succeed({ records: [], unavailable: [] }),
    }).pipe(Effect.orDie);
    expect(response.details).toMatchObject({
      operation: "list",
      workspaceCount: 0,
      listedCount: 0,
    });
    expect(response.content[0]?.type === "text" && response.content[0].text).toContain(
      "Do not auto-adopt or delete an orphan.",
    );
  });

  effectTest(
    "pages healthy and unavailable entries in stable order and warns even off-page",
    function* () {
      const records = Array.from(
        { length: 9 },
        (_, index): WorkspaceRecord => ({
          version: 1,
          handle: {
            workspaceId: `0${index}`,
            ownerId: "parent",
            sourceRoot: "/repo",
            sourceCwd: "/repo",
            cwd: `/private/${index}`,
          },
          status: "discarded",
          baseline: "baseline",
        }),
      ).reverse();
      const artifact = {
        workspaceId: "99",
        status: "unavailable",
        reason: "recovery-record-unavailable",
      } as const;
      const all: unknown[] = [];
      for (const offset of [0, 8]) {
        const response = yield* run({ action: "list", offset }, undefined, {
          workspaceList: () => Effect.succeed({ records, unavailable: [artifact] }),
        }).pipe(Effect.orDie);
        expect(response.details).toMatchObject({
          workspaceCount: 10,
          unavailableCount: 1,
          listedCount: offset === 0 ? 8 : 2,
        });
        expect(response.details.nextOffset).toBe(offset === 0 ? 8 : undefined);
        const text = response.content[0];
        const span = response.details.displayContent!;
        expect(text?.type).toBe("text");
        if (text?.type === "text") {
          const rows = text.text.slice(span.offset, span.offset + span.length).split("\n");
          all.push(
            ...rows.map((line) => Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(line)),
          );
          if (offset === 0) expect(rows.join("\n")).not.toContain(artifact.workspaceId);
          const summary = compactWorkspaceSummary(response.details, "list");
          expect(summary?.outcome).toBe("warning");
          const warning = summary?.issues?.find((issue) => issue.severity === "warning");
          expect(warning?.code).toBe("workspace-records-unavailable");
          expect(text.text).toContain(warning!.detail);
        }
      }
      expect(all).toHaveLength(10);
      expect(all.slice(0, 9)).toEqual(
        [...records].reverse().map((entry) => ({
          workspaceId: entry.handle.workspaceId,
          ownerId: entry.handle.ownerId,
          sourceCwd: entry.handle.sourceCwd,
          cwd: entry.handle.cwd,
          status: entry.status,
        })),
      );
      expect(all[9]).toEqual(artifact);
    },
  );

  effectTest("rejects invalid operations before calling the service", function* () {
    const failed = yield* run({ action: "integrate", workspaceId: "w", revisionId: "r" }).pipe(
      Effect.flip,
      Effect.orDie,
    );
    expect(failed).toMatchObject({ code: "workspace_input_invalid" });
    // Pi `tool_call` handlers can mutate arguments after Pi validated them.
    for (const operation of [
      { action: "bogus" },
      { action: "review", workspaceId: "w", limit: 10_000_000 },
    ])
      // SAFETY: These operations deliberately violate the parameter schema.
      expect(yield* run(operation as never).pipe(Effect.flip, Effect.orDie)).toMatchObject({
        code: "workspace_input_invalid",
      });
  });

  effectTest("warns about what a committed integration left behind", function* () {
    const integrate = (outcome: Partial<WorkspaceIntegrationOutcome>) =>
      run(
        { action: "integrate", workspaceId: "w", revisionId: "r", preparationId: "p" },
        undefined,
        {
          workspaceIntegrate: () =>
            Effect.succeed({
              workerRoot: "/agent/git-workspaces/w/worker",
              uncapturedPaths: [],
              treeRemovalFailed: false,
              leaseReleaseUnconfirmed: false,
              ...outcome,
            }),
        },
      ).pipe(Effect.orDie);
    const clean = yield* integrate({});
    expect(compactWorkspaceSummary(clean.details, "integrate")).toMatchObject({
      issues: [],
      outcome: "success",
    });

    const leftover = yield* integrate({
      uncapturedPaths: ["src/Billing/Invoice.cs", "go.mod"],
      treeRemovalFailed: true,
      leaseReleaseUnconfirmed: true,
    });
    const summary = compactWorkspaceSummary(leftover.details, "integrate");
    expect(summary?.outcome).toBe("warning");
    const issues = summary?.issues ?? [];
    expect(issues).toHaveLength(3);
    const text = leftover.content[0]?.type === "text" ? leftover.content[0].text : "";
    for (const issue of issues) {
      expect(issue.severity).toBe("warning");
      expect(
        issueMessageStyleProblems(issue.message, { forbidden: ["/agent/git-workspaces"] }),
      ).toEqual([]);
      expect(text).toContain(issue.detail);
    }
    // The agent learns which files were kept and where.
    expect(text).toContain("src/Billing/Invoice.cs");
    expect(text).toContain("/agent/git-workspaces/w/worker");
  });
});
