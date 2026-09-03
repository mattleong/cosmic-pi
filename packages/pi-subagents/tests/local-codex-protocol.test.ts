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

  it.effect("decodes item started/completed outcomes across a bounded behavior matrix", () =>
    Effect.gen(function* () {
      const ordinaryItem = { id: "item-1", type: "message", text: "hello" };
      expect(
        yield* decodeCodexNotification("item/started", {
          threadId: "t",
          turnId: "u",
          item: ordinaryItem,
        }),
      ).toMatchObject({ type: "item_started" });
      expect(
        yield* decodeCodexNotification("item/completed", {
          threadId: "t",
          turnId: "u",
          item: ordinaryItem,
        }),
      ).toMatchObject({ type: "item_completed" });

      const collabBase = {
        id: "call-1",
        type: "collabAgentToolCall",
        senderThreadId: "t",
        receiverThreadIds: ["native-1"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      };
      const collabCases: ReadonlyArray<
        ["item/started" | "item/completed", string, string, string]
      > = [
        ["item/started", "spawnAgent", "inProgress", "activity"],
        ["item/completed", "spawnAgent", "inProgress", "activity"],
        ["item/completed", "spawnAgent", "completed", "running"],
        ["item/completed", "spawnAgent", "failed", "failed"],
        ["item/completed", "closeAgent", "completed", "stopped"],
        ["item/completed", "wait", "completed", "activity"],
      ];
      for (const [method, tool, status, state] of collabCases) {
        const notification = yield* decodeCodexNotification(method, {
          threadId: "t",
          turnId: "u",
          item: { ...collabBase, tool, status },
        });
        expect(notification).toMatchObject({ type: "native_activity", kind: tool, state });
      }
      const receiverless = yield* decodeCodexNotification("item/completed", {
        threadId: "t",
        turnId: "u",
        item: { ...collabBase, tool: "spawnAgent", status: "completed", receiverThreadIds: [] },
      });
      expect(receiverless).toMatchObject({ type: "native_activity", state: "activity" });

      const activityBase = { agentThreadId: "native-1", agentPath: "root/reviewer" };
      expect(
        yield* decodeCodexNotification("item/started", {
          threadId: "t",
          turnId: "u",
          item: { id: "a-1", type: "subAgentActivity", kind: "started", ...activityBase },
        }),
      ).toMatchObject({ type: "ignored" });
      const activityCases: ReadonlyArray<[string, string]> = [
        ["started", "running"],
        ["interacted", "activity"],
        ["interrupted", "stopped"],
      ];
      for (const [kind, state] of activityCases) {
        const notification = yield* decodeCodexNotification("item/completed", {
          threadId: "t",
          turnId: "u",
          item: { id: "a-1", type: "subAgentActivity", kind, ...activityBase },
        });
        expect(notification).toMatchObject({ type: "native_activity", state });
      }
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
