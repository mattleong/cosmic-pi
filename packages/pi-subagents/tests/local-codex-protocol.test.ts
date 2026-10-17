import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { decodeCodexNotification } from "../src/backend/local-codex-protocol.ts";

const decode = (method: string, item: Schema.Json) =>
  decodeCodexNotification(method, { threadId: "t", turnId: "u", item });

describe("local Codex protocol", () => {
  it.effect("preserves bounded file-change paths and move destinations", () =>
    Effect.gen(function* () {
      const notification = yield* decode("item/started", {
        id: "item-1",
        type: "fileChange",
        status: "inProgress",
        changes: [
          { path: "src/a.ts", kind: { type: "update", move_path: "src/b.ts" }, diff: "x" },
          { path: "src/new.ts", kind: { type: "add" }, diff: "y" },
        ],
      });
      expect(notification).toMatchObject({
        type: "item_started",
        item: {
          type: "fileChange",
          changes: [
            { path: "src/a.ts", kind: { type: "update", move_path: "src/b.ts" } },
            { path: "src/new.ts", kind: { type: "add" } },
          ],
        },
      });
    }),
  );

  it.effect("counts newer native-agent shapes as activity but rejects an item without an id", () =>
    Effect.gen(function* () {
      for (const item of [
        { id: "call-1", type: "collabAgentToolCall", tool: "unknownFutureTool", status: "done" },
        { id: "a-1", type: "subAgentActivity", kind: "paused", agentThreadId: "native-1" },
      ])
        expect(yield* decode("item/completed", item)).toMatchObject({
          type: "native_activity",
          activityId: item.id,
          state: "activity",
        });
      const error = yield* decode("item/completed", {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("SchemaError");
    }),
  );
});
