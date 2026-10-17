import * as Effect from "effect/Effect";
import { describe, expect } from "vitest";
import { effectTest } from "../support/effect-test.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
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
});
