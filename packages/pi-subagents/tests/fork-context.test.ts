import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Schema from "effect/Schema";
import { createForkedSession, type ChildLaunchRequest } from "../src/boundary/child-process.ts";
import { nodeFsPromises as fs, nodePath as path } from "./support/node-builtins.ts";

const tool = {
  name: "parent_only",
  description: "parent capability",
  parameters: { type: "object" },
};

const forkRequest = (directory: string, parent: SessionManager): ChildLaunchRequest => ({
  runId: "fork-test",
  name: "fork",
  cwd: directory,
  context: "fork",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "faux/faux",
  effort: "off",
  activeTools: ["read"],
  projectTrusted: false,
  parentSessionId: parent.getSessionId(),
  parentSessionFile: parent.getSessionFile()!,
  parentLeafId: parent.getLeafId()!,
  systemPrompt: "child-owned prompt",
});

describe("forked Pi transcript", () => {
  it.live(
    "restores plaintext from encrypted checkpoints without reviving ordinary compacted history",
    () =>
      Effect.gen(function* () {
        const temporaryRoot = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"));
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(temporaryRoot, "pi-fork-encrypted-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        const parent = SessionManager.create(directory, directory);
        parent.appendMessage({
          role: "system",
          content: "parent private instructions",
          timestamp: 1,
        });
        parent.appendMessage({ role: "user", content: "already summarized history", timestamp: 2 });
        const retained = parent.appendMessage({
          role: "user",
          content: "retained question",
          timestamp: 3,
        });
        parent.appendCompaction("ordinary summary", retained, 100);
        const answer = parent.appendMessage(fauxAssistantMessage("retained answer"));
        const encrypted = parent.appendCompaction(
          "opaque checkpoint placeholder",
          answer,
          100,
          {
            type: "pi-better-openai.compaction.v1",
            checkpoint: {
              output: [{ type: "compaction", encrypted_content: "parent encrypted payload" }],
            },
          },
          true,
        );
        parent.appendMessage({ role: "user", content: "next question", timestamp: 4 });
        const last = parent.appendMessage(fauxAssistantMessage("next answer"));
        const newest = parent.appendCompaction(
          "opaque checkpoint placeholder",
          last,
          100,
          {
            type: "pi-better-openai.compaction.v1",
            checkpoint: {
              output: [{ type: "compaction", encrypted_content: "new parent encrypted payload" }],
            },
          },
          true,
        );
        const original = yield* Effect.promise(() => fs.readFile(parent.getSessionFile()!, "utf8"));
        const childFile = yield* createForkedSession(forkRequest(directory, parent), directory);
        const child = SessionManager.open(childFile);
        const context = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
          child.buildSessionContext().messages,
        );
        for (const content of [
          "ordinary summary",
          "retained question",
          "retained answer",
          "next question",
          "next answer",
        ])
          expect(context).toContain(content);
        expect(context).not.toMatch(
          /already summarized history|parent private instructions|opaque checkpoint placeholder|encrypted payload/,
        );
        expect(child.getEntry(encrypted)).toMatchObject({ type: "custom", id: encrypted });
        expect(child.getEntry(newest)).toMatchObject({ type: "custom", id: newest });
        expect(child.getLeafId()).toBe(newest);
        expect(
          Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(child.getBranch()),
        ).not.toContain("encrypted_content");
        expect(yield* Effect.promise(() => fs.readFile(parent.getSessionFile()!, "utf8"))).toBe(
          original,
        );
      }),
  );
  for (const version of [3, 2]) {
    it.live(`preserves version ${version} parent bytes without a final newline`, () =>
      Effect.gen(function* () {
        const temporaryRoot = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"));
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(temporaryRoot, "pi-fork-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        const parent = SessionManager.create(directory, directory);
        const retainedId = parent.appendMessage({
          role: "user",
          content: "retained conversation",
          timestamp: 1,
        });
        parent.appendMessage(fauxAssistantMessage("retained answer"));
        const compactionId = parent.appendCompaction("retained summary", retainedId, 42);
        const leafId = parent.appendLabelChange(retainedId, "parent bookmark");
        const entries = parent.getBranch().map((entry) => {
          if (entry.type !== "compaction") return entry;
          const legacyCompaction = { ...entry };
          delete legacyCompaction.systemMessage;
          return legacyCompaction;
        });
        const hookEntry = {
          type: "message",
          id: "legacy-hook",
          parentId: retainedId,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: {
            role: version === 2 ? "hookMessage" : "custom",
            customType: "retained-hook",
            content: "retained custom conversation",
            display: true,
            timestamp: 2,
          },
        };
        // Insert a legacy role in the retained branch to prove native migration runs.
        const fixtureEntries = [
          entries[0],
          hookEntry,
          ...entries
            .slice(1)
            .map((entry, index) => (index === 0 ? { ...entry, parentId: hookEntry.id } : entry)),
        ];
        const original = Buffer.from(
          [
            {
              type: "session",
              version,
              id: parent.getSessionId(),
              cwd: directory,
              timestamp: "2026-01-01T00:00:00.000Z",
            },
            ...fixtureEntries,
          ]
            .map((entry) => Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(entry))
            .join("\n"),
        );
        yield* Effect.promise(() => fs.writeFile(parent.getSessionFile()!, original));
        const childFile = yield* createForkedSession(forkRequest(directory, parent), directory);
        expect(yield* Effect.promise(() => fs.readFile(parent.getSessionFile()!))).toEqual(
          original,
        );
        const child = SessionManager.open(childFile);
        expect(child.getLeafId()).toBe(leafId);
        expect(child.getEntry(leafId!)).toMatchObject({
          type: "custom",
          customType: "pi-subagents-fork-anchor",
          parentId: compactionId,
        });
        expect(child.getEntry(compactionId)).toMatchObject({ firstKeptEntryId: retainedId });
        expect(child.getEntry(compactionId)).not.toHaveProperty("systemMessage");
        const context = child.buildSessionContext().messages;
        expect(context.map((message) => message.role)).toEqual([
          "compactionSummary",
          "user",
          "custom",
          "assistant",
        ]);
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(context)).toContain(
          "retained conversation",
        );
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(context)).toContain(
          "retained answer",
        );
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(context)).toContain(
          "retained custom conversation",
        );
      }),
    );
  }
  for (const anchor of ["system", "label"] as const) {
    it.live(`removes parent prompt authority without losing a ${anchor} compaction anchor`, () =>
      Effect.gen(function* () {
        const temporaryRoot = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"));
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join(temporaryRoot, "pi-fork-"))),
          (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
        );
        const parent = SessionManager.create(directory, directory);
        parent.appendMessage({
          role: "system",
          content: "opaque parent secret",
          toolsAdded: [tool],
          timestamp: 1,
        });
        parent.appendMessage({ role: "user", content: "summarized conversation", timestamp: 2 });
        const systemId = parent.appendMessage({
          role: "system",
          content: "",
          sections: { parent_section: "parent section secret" },
          toolsRemoved: [{ name: "read" }],
          timestamp: 3,
        });
        const labelId = parent.appendLabelChange(systemId, "parent bookmark");
        parent.appendMessage({ role: "user", content: "retained conversation", timestamp: 4 });
        parent.appendMessage({
          ...fauxAssistantMessage("retained answer"),
          content: [
            {
              type: "thinking",
              thinking: "signed private reasoning",
              thinkingSignature: "signature",
            },
            { type: "text", text: "retained answer" },
          ],
        });
        const compactionId = parent.appendCompaction(
          "retained summary",
          anchor === "system" ? systemId : labelId,
          42,
          { ownedDetail: "preserve" },
          true,
        );
        parent.appendMessage({
          role: "system",
          content: "post-compaction parent secret",
          toolsAdded: [tool],
          timestamp: 5,
        });
        const original = yield* Effect.promise(() => fs.readFile(parent.getSessionFile()!, "utf8"));
        const parentEntries = parent.getBranch();
        expect(parent.getEntry(compactionId)).toHaveProperty("systemMessage");
        const childFile = yield* createForkedSession(forkRequest(directory, parent), directory);
        const child = SessionManager.open(childFile);
        const entries = child.getBranch();
        expect(entries.map(({ id, parentId, timestamp }) => ({ id, parentId, timestamp }))).toEqual(
          parentEntries.map(({ id, parentId, timestamp }) => ({ id, parentId, timestamp })),
        );
        expect(child.getEntry(systemId)).toMatchObject({
          type: "custom",
          customType: "pi-subagents-fork-anchor",
        });
        expect(child.getEntry(labelId)).toMatchObject({
          type: "custom",
          customType: "pi-subagents-fork-anchor",
        });
        expect(child.getEntry(compactionId)).toMatchObject({
          summary: "retained summary",
          details: { ownedDetail: "preserve" },
          firstKeptEntryId: anchor === "system" ? systemId : labelId,
        });
        expect(child.getEntry(compactionId)).not.toHaveProperty("systemMessage");
        const context = child.buildSessionContext().messages;
        expect(context.map((message) => message.role)).toEqual([
          "compactionSummary",
          "user",
          "assistant",
        ]);
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(context)).toContain(
          "retained conversation",
        );
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(context)).toContain(
          "retained answer",
        );
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(entries)).not.toMatch(
          /parent secret|parent section secret|parent_only|signed private reasoning|signature/,
        );
        expect(yield* Effect.promise(() => fs.readFile(parent.getSessionFile()!, "utf8"))).toBe(
          original,
        );
        child.appendMessage({
          role: "system",
          content: "child-owned prompt",
          toolsAdded: [{ ...tool, name: "child_only" }],
          timestamp: 6,
        });
        const resumed = SessionManager.open(childFile).buildSessionContext().messages;
        expect(resumed.at(-1)).toMatchObject({
          role: "system",
          content: "child-owned prompt",
          toolsAdded: [{ name: "child_only" }],
        });
      }),
    );
  }
});
