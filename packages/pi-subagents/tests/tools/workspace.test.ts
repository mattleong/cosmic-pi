import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import { compactWorkspaceSummary } from "../../src/tools/compact-workspace-summary.ts";
import type { WorkspaceRecord } from "../../src/workspace/model.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";

describe("workspace tool", () => {
  effectTest(
    "returns complete immutable pages without persisting patches in details",
    function* () {
      const diff = "diff --git a/file b/file\n" + "content\n".repeat(3_000);
      const service = {
        ...subagentServiceDouble({}),
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
            workspaceId,
            revisionId: "immutable",
            changedPaths: ["file"],
            diff: diff.slice(offset, next),
            offset,
            totalChars: diff.length,
            ...(next < diff.length && { nextOffset: next }),
          });
        },
      };
      const first = yield* executeWorkspaceAction(
        { action: "review", workspaceId: "workspace" },
        "parent",
      ).pipe(Effect.provideService(SubagentService, service), Effect.orDie);
      expect(first.details).toMatchObject({
        revisionId: "immutable",
        offset: 0,
        totalChars: diff.length,
        nextOffset: 16_000,
      });
      const second = yield* executeWorkspaceAction(
        { action: "review", workspaceId: "workspace", revisionId: "immutable", offset: 16_000 },
        "parent",
      ).pipe(Effect.provideService(SubagentService, service), Effect.orDie);
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
      const service = {
        ...subagentServiceDouble({}),
        workspaceIntegrate: (
          workspaceId: string,
          revisionId: string,
          preparationId: string,
          caller?: string,
        ) => {
          expect([workspaceId, revisionId, preparationId, caller]).toEqual([
            "w",
            "r",
            "p",
            "child",
          ]);
          return Effect.fail(denial);
        },
      };
      const failed = yield* executeWorkspaceAction(
        { action: "integrate", workspaceId: "w", revisionId: "r", preparationId: "p" },
        "child",
      ).pipe(Effect.provideService(SubagentService, service), Effect.flip, Effect.orDie);
      expect(failed).toBe(denial);
    },
  );

  effectTest("persists bounded empty-list counts without changing orphan guidance", function* () {
    const response = yield* executeWorkspaceAction({ action: "list" }).pipe(
      Effect.provideService(SubagentService, {
        ...subagentServiceDouble({}),
        workspaceList: () => Effect.succeed({ records: [], unavailable: [] }),
      }),
      Effect.orDie,
    );
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
      const service = subagentServiceDouble({
        workspaceList: () => Effect.succeed({ records, unavailable: [artifact] }),
      });
      const all: unknown[] = [];
      for (const offset of [0, 8]) {
        const response = yield* executeWorkspaceAction({ action: "list", offset }).pipe(
          Effect.provideService(SubagentService, service),
          Effect.orDie,
        );
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
            ...rows.map((line) =>
              Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line),
            ),
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

  effectTest("rejects incomplete integration before calling the service", function* () {
    const failed = yield* executeWorkspaceAction({
      action: "integrate",
      workspaceId: "w",
      revisionId: "r",
    }).pipe(
      Effect.provideService(SubagentService, subagentServiceDouble({})),
      Effect.flip,
      Effect.orDie,
    );
    expect(failed).toMatchObject({ code: "workspace_input_invalid" });
  });
});
