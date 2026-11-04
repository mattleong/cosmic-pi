import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { getTextContent } from "pi-code-previews";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerParentConversation } from "../src/parent/application.ts";
import { PARENT_TOOL } from "../src/parent/contract.ts";
import { ParentTranscript } from "../src/parent/reader.ts";
import {
  MAX_PARENT_MESSAGES,
  parentConversation,
  parentMessageCount,
} from "../src/parent/transcript.ts";
import { registerParentReference } from "../src/parent-reference.ts";

const PARENT_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";

let entryCount = 0;
/** A session entry's fields beyond its id, parent, and time, as Pi writes them. */
type EntryFields = { readonly [key: string]: Schema.Json };

const entry = (parentId: string | null, fields: EntryFields) => {
  entryCount++;
  const id = `e${entryCount}`;
  return {
    id,
    line: JSON.stringify({ id, parentId, timestamp: "2026-11-04T06:18:36.000Z", ...fields }),
  };
};
const message = (parentId: string | null, body: EntryFields) =>
  entry(parentId, { type: "message", message: body });
const user = (parentId: string | null, text: string) =>
  message(parentId, { role: "user", content: text });
const assistant = (parentId: string | null, content: Array<EntryFields>) =>
  message(parentId, { role: "assistant", content });

const jsonl = (entries: ReadonlyArray<{ readonly line: string }>) =>
  Arr.join(
    [
      JSON.stringify({ type: "session", id: PARENT_ID, cwd: "/project" }),
      ...Arr.map(entries, (item) => item.line),
    ],
    "\n",
  ) + "\n";

/** A parent that asked, answered with a tool call, then branched back and asked again. */
const branchedSession = () => {
  const model = entry(null, { type: "model_change", provider: "p", modelId: "m" });
  const first = user(model.id, "Deploy the cart service?");
  const call = assistant(first.id, [
    { type: "text", text: "Checking the tests." },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pnpm test" } },
  ]);
  const result = message(call.id, {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "FAIL cart.test.ts" }],
    isError: true,
  });
  const abandoned = user(result.id, "An abandoned branch");
  const retry = user(result.id, "Fix the failing test first");
  const note = entry(retry.id, {
    type: "custom_message",
    customType: "pi-intercom-message",
    content: "A message from another session",
    display: true,
  });
  const hidden = entry(note.id, { type: "custom", customType: "state", data: {} });
  const answer = assistant(hidden.id, [{ type: "text", text: "Fixed `cart.test.ts`." }]);
  return { entries: [model, first, call, result, abandoned, retry, note, hidden, answer] };
};

describe("parent conversation", () => {
  it("follows the parent's current branch, oldest first, with each tool's outcome", () => {
    const conversation = parentConversation(PARENT_ID, jsonl(branchedSession().entries), false, 15);
    expect(Arr.map(conversation.items, (item) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
      "note",
      "assistant",
    ]);
    expect(
      Arr.join(
        Arr.map(conversation.items, (item) => item.text),
        "\n",
      ),
    ).not.toContain("abandoned");
    expect(conversation.items[1]?.tools).toEqual([
      expect.objectContaining({
        name: "bash",
        subject: "pnpm test",
        outcome: "failed",
        output: "FAIL cart.test.ts",
      }),
    ]);
    expect(conversation.earlier).toBe(false);
  });

  it("names each call by the argument a person recognizes, even when its input is clipped", () => {
    const long = `pnpm test ${Str.repeat(300)("x")}`;
    const call = assistant(null, [
      {
        type: "toolCall",
        id: "c1",
        name: "edit",
        arguments: { oldText: "a", newText: "b", path: "src/cart.ts" },
      },
      { type: "toolCall", id: "c2", name: "bash", arguments: { command: long } },
      { type: "toolCall", id: "c3", name: "custom", arguments: { limit: 3, topic: "deploys" } },
      { type: "toolCall", id: "c4", name: "noargs", arguments: {} },
    ]);
    const tools = parentConversation(PARENT_ID, jsonl([call]), false, 15).items[0]?.tools ?? [];
    const subjects = Arr.map(tools, (tool) => tool.subject);
    expect(subjects[0]).toBe("src/cart.ts");
    expect(subjects[1]).toMatch(/^pnpm test x+…$/u);
    expect(subjects[2]).toBe("deploys");
    expect(subjects[3]).toBe("");
  });

  it("reads only the latest messages and says earlier ones exist", () => {
    const conversation = parentConversation(PARENT_ID, jsonl(branchedSession().entries), false, 2);
    expect(Arr.map(conversation.items, (item) => item.role)).toEqual(["note", "assistant"]);
    expect(conversation.earlier).toBe(true);
  });

  it("stops at a compaction and starts with its summary", () => {
    const first = user(null, "Old question");
    const compaction = entry(first.id, {
      type: "compaction",
      summary: "The user asked about deploys.",
      firstKeptEntryId: first.id,
      tokensBefore: 1000,
    });
    const latest = user(compaction.id, "New question");
    const conversation = parentConversation(
      PARENT_ID,
      jsonl([first, compaction, latest]),
      false,
      15,
    );
    expect(Arr.map(conversation.items, (item) => item.role)).toEqual(["summary", "user"]);
    expect(conversation.compacted).toBe(true);
    expect(conversation.earlier).toBe(true);
  });

  it("skips a cut first line and malformed lines, and notes the branch continues before the window", () => {
    const { entries } = branchedSession();
    const text = jsonl(entries);
    const cut = Option.getOrElse(Str.indexOf(entries[5]?.line ?? "")(text), () => 0) + 10;
    const window = Str.slice(cut)(text);
    const conversation = parentConversation(PARENT_ID, `${window}not json\n`, true, 15);
    expect(Arr.map(conversation.items, (item) => item.role)).toEqual(["note", "assistant"]);
    expect(conversation.earlier).toBe(true);
  });

  it("reads the default count when the request is absent or not positive, and caps large ones", () => {
    expect(parentMessageCount(undefined)).toBe(15);
    expect(parentMessageCount(0)).toBe(15);
    expect(parentMessageCount(-3)).toBe(15);
    expect(parentMessageCount(7.8)).toBe(7);
    expect(parentMessageCount(500)).toBe(MAX_PARENT_MESSAGES);
  });
});

/** A temporary parent session file, removed when the test's scope closes. */
const parentFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "rex-btw-parent-" });
  const file = path.join(root, "parent.jsonl");
  yield* fs.writeFileString(file, jsonl(branchedSession().entries));
  return { root, file, fs, path };
});

describe("parent transcript file", () => {
  const read = (path: string) =>
    ParentTranscript.use((transcript) => transcript.read({ id: PARENT_ID, path }, 15)).pipe(
      Effect.provide(ParentTranscript.layer),
    );

  it.effect("reads a regular file and refuses a moved file or a link", () =>
    Effect.gen(function* () {
      const { root, file, fs, path } = yield* parentFile;
      const link = path.join(root, "link.jsonl");
      yield* fs.symlink(file, link);
      expect((yield* read(file)).items.length).toBe(5);
      expect((yield* Effect.flip(read(link))).reason).toBe("unreadable");
      expect((yield* Effect.flip(read(path.join(root, "gone.jsonl")))).reason).toBe("missing");
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );
});

const child = (flags: Record<string, string | boolean | undefined>) => {
  const notify = vi.fn();
  const setWidget = vi.fn();
  const host = recordingExtensionHost(
    {},
    { registerFlag() {}, getFlag: (name: string) => flags[name] },
  );
  registerParentReference(host.pi);
  registerParentConversation(host.pi, { loadSettings: () => Promise.resolve() });
  const ctx = extensionContextFixture({
    cwd: "/project",
    mode: "tui" as const,
    hasUI: true,
    ui: { notify, setWidget },
  });
  return {
    notify,
    setWidget,
    tools: host.tools,
    start: () => host.emit("session_start", ctx),
    shutdown: () => host.emit("session_shutdown", ctx),
  };
};

describe("BTW child registration", () => {
  it.effect(
    "gives a child with a parent the read-only tool and tells the user what the pane is",
    () =>
      Effect.gen(function* () {
        const { file } = yield* parentFile;
        const h = child({
          "rex-btw": true,
          "rex-btw-parent": PARENT_ID,
          "rex-btw-parent-file": file,
        });
        yield* Effect.promise(h.start);
        // A widget, not a notice: Pi replaces a notice with the next one.
        expect(h.setWidget).toHaveBeenCalledOnce();
        expect(h.notify).not.toHaveBeenCalled();
        const tool = h.tools.get(PARENT_TOOL);
        expect(tool).toBeDefined();
        const result = yield* Effect.promise(() =>
          Promise.resolve(
            tool!.execute(
              "call",
              { messages: 2 },
              undefined,
              undefined,
              extensionContextFixture({}),
            ),
          ),
        );
        expect(getTextContent(result.content)).toContain("Fixed `cart.test.ts`.");
        expect(getTextContent(result.content)).not.toContain(file);
        yield* Effect.promise(h.shutdown);
      }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect(
    "orients a child that can't see its parent and registers nothing for other sessions",
    () =>
      Effect.gen(function* () {
        const blind = child({ "rex-btw": true });
        yield* Effect.promise(blind.start);
        expect(blind.setWidget).toHaveBeenCalledOnce();
        expect(blind.tools.has(PARENT_TOOL)).toBe(false);
        yield* Effect.promise(blind.shutdown);
        // Pi clears widgets when it replaces the session, so the next start shows the line again.
        yield* Effect.promise(blind.start);
        expect(blind.setWidget).toHaveBeenCalledTimes(2);
        yield* Effect.promise(blind.shutdown);

        const ordinary = child({});
        yield* Effect.promise(ordinary.start);
        expect(ordinary.setWidget).not.toHaveBeenCalled();
        expect(ordinary.notify).not.toHaveBeenCalled();
        expect(ordinary.tools.has(PARENT_TOOL)).toBe(false);
        yield* Effect.promise(ordinary.shutdown);
      }),
  );
});
