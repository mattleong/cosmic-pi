import * as Effect from "effect/Effect";
import { describe, expect } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
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
      const firstText = first.content[0];
      const secondText = second.content[0];
      expect(firstText?.type === "text" && firstText.text.includes(diff.slice(0, 16_000))).toBe(
        true,
      );
      expect(secondText?.type === "text" && secondText.text.includes(diff.slice(16_000))).toBe(
        true,
      );
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
