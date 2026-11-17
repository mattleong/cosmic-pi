import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  readSessionEntries,
  sessionEntriesReply,
  transcriptMessages,
} from "../src/boundary/session-transcript.ts";

const entry = (id: string, parentId: string | null, role: "user" | "assistant", text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message:
    role === "user"
      ? { role, content: text, timestamp: 0 }
      : { role, content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 },
});
const line = (value: ReturnType<typeof entry> | { readonly type: "session" }) =>
  JSON.stringify(value);

describe("a run's saved conversation", () => {
  it.effect("joins the session file with what the live child holds past it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-subagents-transcript-" });
      const file = `${directory}/session.jsonl`;
      yield* fs.writeFileString(
        file,
        Arr.join(
          [
            line({ type: "session" }),
            line(entry("e1", null, "user", "task")),
            line(entry("e2", "e1", "assistant", "first")),
            // Pi appends whole lines, so a reader mid-append sees a cut one and skips it.
            '{"type":"message","id":"e3","parentId":"e2","mess',
          ],
          "\n",
        ),
      );
      const saved = yield* readSessionEntries(file);
      expect(Arr.map(saved, ({ id }) => id)).toEqual(["e1", "e2"]);

      const reply = sessionEntriesReply({
        entries: [entry("e3", "e2", "user", "more"), entry("e4", "e3", "assistant", "second")],
        leafId: "e4",
      });
      const roles = Arr.map(
        transcriptMessages([...saved, ...reply.entries], reply.leafId),
        ({ role }) => role,
      );
      expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
      // Without a leaf, the branch ends at the last entry.
      expect(transcriptMessages(saved, undefined)).toHaveLength(2);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("reads a missing file and an unreadable reply as empty", () =>
    Effect.gen(function* () {
      expect(yield* readSessionEntries("/nonexistent/pi-subagents/session.jsonl")).toEqual([]);
      expect(sessionEntriesReply(undefined)).toEqual({ entries: [], leafId: undefined });
      expect(sessionEntriesReply({ entries: "nope" }).entries).toEqual([]);
      expect(transcriptMessages([], undefined)).toEqual([]);
    }),
  );
});
