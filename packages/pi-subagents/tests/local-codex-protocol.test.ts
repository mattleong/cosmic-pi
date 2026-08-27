import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeCodexNotification } from "../src/backend/local-codex-protocol.ts";

describe("local Codex protocol", () => {
  it.effect("preserves bounded file-change paths and move destinations", () =>
    Effect.gen(function* () {
      const notification = yield* decodeCodexNotification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "item-1",
          type: "fileChange",
          status: "inProgress",
          changes: [
            { path: "src/a.ts", kind: { type: "update", move_path: "src/b.ts" }, diff: "x" },
            { path: "src/new.ts", kind: { type: "add" }, diff: "y" },
          ],
        },
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

  it.effect("decodes bounded native-agent lifecycle without creating Pi run nodes", () =>
    Effect.gen(function* () {
      const spawned = yield* decodeCodexNotification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "call-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread-1",
          receiverThreadIds: ["native-1"],
          prompt: null,
          model: "gpt-native",
          reasoningEffort: "high",
          agentsStates: { "native-1": { status: "running", message: null } },
        },
      });
      expect(spawned).toMatchObject({
        type: "native_activity",
        activityId: "native-1",
        kind: "spawnAgent",
        state: "running",
      });

      const interrupted = yield* decodeCodexNotification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "activity-1",
          type: "subAgentActivity",
          kind: "interrupted",
          agentThreadId: "native-1",
          agentPath: "root/reviewer",
        },
      });
      expect(interrupted).toMatchObject({
        type: "native_activity",
        activityId: "native-1",
        state: "stopped",
      });
    }),
  );

  it.effect("fails closed on malformed native-agent shapes", () =>
    Effect.gen(function* () {
      const error = yield* decodeCodexNotification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "call-1",
          type: "collabAgentToolCall",
          tool: "unknownFutureTool",
          status: "completed",
        },
      }).pipe(Effect.flip);
      expect(error._tag).toBe("SchemaError");
    }),
  );
});
