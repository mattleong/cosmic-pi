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
});
