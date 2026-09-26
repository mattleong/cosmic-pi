import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeCodexNotification } from "../src/backend/local-codex-protocol.ts";

const decode = <Item>(method: string, item: Item) =>
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

  it.effect("decodes item started/completed outcomes across a bounded behavior matrix", () =>
    Effect.gen(function* () {
      const ordinaryItem = { id: "item-1", type: "message", text: "hello" };
      expect(yield* decode("item/started", ordinaryItem)).toMatchObject({ type: "item_started" });
      expect(yield* decode("item/completed", ordinaryItem)).toMatchObject({
        type: "item_completed",
      });

      const collabBase = {
        id: "call-1",
        type: "collabAgentToolCall",
        senderThreadId: "t",
        receiverThreadIds: ["native-1"],
        prompt: null,
        model: "gpt-native",
        reasoningEffort: "high",
        agentsStates: { "native-1": { status: "running", message: null } },
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
      for (const [method, tool, status, state] of collabCases)
        expect(yield* decode(method, { ...collabBase, tool, status })).toMatchObject({
          type: "native_activity",
          activityId: "native-1",
          kind: tool,
          state,
        });
      // The receiverless row also covers nullable model metadata and an empty state record.
      const receiverless = {
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: [],
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      };
      expect(yield* decode("item/completed", { ...collabBase, ...receiverless })).toMatchObject({
        type: "native_activity",
        activityId: "call-1",
        state: "activity",
      });

      const activityBase = { agentThreadId: "native-1", agentPath: "root/reviewer" };
      expect(
        yield* decode("item/started", {
          id: "a-1",
          type: "subAgentActivity",
          kind: "started",
          ...activityBase,
        }),
      ).toMatchObject({ type: "ignored" });
      const activityCases: ReadonlyArray<[string, string]> = [
        ["started", "running"],
        ["interacted", "activity"],
        ["interrupted", "stopped"],
      ];
      for (const [kind, state] of activityCases)
        expect(
          yield* decode("item/completed", {
            id: "a-1",
            type: "subAgentActivity",
            kind,
            ...activityBase,
          }),
        ).toMatchObject({ type: "native_activity", activityId: "native-1", state });
    }),
  );

  it.effect("fails closed on malformed native-agent shapes", () =>
    Effect.gen(function* () {
      const error = yield* decode("item/completed", {
        id: "call-1",
        type: "collabAgentToolCall",
        tool: "unknownFutureTool",
        status: "completed",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("SchemaError");
    }),
  );
});
