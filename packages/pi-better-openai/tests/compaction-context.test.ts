import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  SessionManager,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { describe, expect, it, vi } from "vitest";
import { betterOpenAIWithDependencies } from "../src/application.ts";
import { reconstructOpenAIContext, repairOpenAIContext } from "../src/compaction/context.ts";
import { prepareOpenAIFallback } from "../src/compaction/fallback.ts";
import {
  OPENAI_COMPACTION_DETAILS_TYPE,
  OPENAI_COMPACTION_SUMMARY,
} from "../src/compaction/protocol.ts";
import { appendAssistant, assistantMessage, serializedSnapshot } from "./helpers.ts";

const details = {
  type: OPENAI_COMPACTION_DETAILS_TYPE,
  checkpoint: {
    version: 1,
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.5",
    output: [{ type: "compaction", encrypted_content: "encrypted" }],
    omittedEntryIds: [],
    createdAt: 0,
  },
};
const preparation = {
  firstKeptEntryId: "ignored",
  messagesToSummarize: [],
  turnPrefixMessages: [],
  isSplitTurn: false,
  tokensBefore: 100,
  fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
} satisfies SessionBeforeCompactEvent["preparation"];
const appendUser = (manager: SessionManager, content: string) =>
  manager.appendMessage({ role: "user", content, timestamp: 1 });
const appendCheckpoint = (manager: SessionManager, retained = manager.getLeafId()!) =>
  manager.appendCompaction(OPENAI_COMPACTION_SUMMARY, retained, 100, details, true);

function history() {
  const manager = SessionManager.inMemory("/virtual/repair");
  manager.appendMessage({
    role: "system",
    content: "opaque",
    sections: { rules: "old" },
    timestamp: 0,
  });
  appendUser(manager, "original dialogue");
  appendCheckpoint(manager);
  manager.appendMessage({
    role: "system",
    content: "",
    sections: { rules: "current" },
    timestamp: 2,
  });
  appendUser(manager, "second dialogue");
  appendCheckpoint(manager);
  return manager;
}

describe("owned checkpoint reconstruction", () => {
  it("the host boundary aborts requests and cancels compaction when owned-context repair is unavailable", () => {
    const { pi, handlers } = recordingExtensionHost(
      {},
      { registerFlag: vi.fn(), events: { emit: vi.fn(), on: vi.fn() } },
    );
    betterOpenAIWithDependencies(pi);
    const abort = vi.fn();
    const notify = vi.fn();
    const ctx = {
      ...extensionContextFixture({ abort, ui: { notify } }),
      sessionManager: history(),
    };
    expect(
      handlers.get("context_with_system")[0]!(
        {
          type: "context_with_system",
          messages: ctx.sessionManager.buildSessionContext().messages,
        },
        ctx,
      ),
    ).toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalled();
    expect(
      handlers.get("session_before_compact")[0]!(
        {
          type: "session_before_compact",
          preparation,
          branchEntries: ctx.sessionManager.getBranch(),
          reason: "manual",
          willRetry: false,
          signal: new AbortController().signal,
        },
        ctx,
      ),
    ).toEqual({ cancel: true });
  });
  it("restores all dialogue with one canonical snapshot and genuine tail updates, without mutation", () => {
    const manager = history();
    manager.appendMessage({
      role: "system",
      content: "tail instruction",
      sections: { rules: "tail" },
      timestamp: 3,
    });
    appendUser(manager, "tail dialogue");
    const branch = manager.getBranch();
    const before = serializedSnapshot(branch);
    const restored = reconstructOpenAIContext(branch)!;
    expect(serializedSnapshot(restored.messages)).toContain("original dialogue");
    expect(serializedSnapshot(restored.messages)).toContain("second dialogue");
    expect(serializedSnapshot(restored.messages)).toContain("tail dialogue");
    expect(serializedSnapshot(restored.messages)).not.toContain(OPENAI_COMPACTION_SUMMARY);
    expect(Arr.filter(restored.messages, (message) => message.role === "system")).toHaveLength(2);
    expect(serializedSnapshot(restored.coveredEntries)).not.toContain("tail dialogue");
    expect(serializedSnapshot(restored.coveredEntries)).not.toContain("tail instruction");
    expect(serializedSnapshot(branch)).toBe(before);
  });

  it("keeps parent anchors and stops at the preceding ordinary Pi compaction", () => {
    const manager = SessionManager.inMemory("/virtual/ordinary-boundary");
    appendUser(manager, "already summarized secret");
    const retained = appendUser(manager, "ordinary retained dialogue");
    manager.appendCompaction("ordinary prior summary", retained, 100, {
      readFiles: ["prior.ts"],
      modifiedFiles: [],
    });
    appendCheckpoint(manager, retained);
    appendUser(manager, "checkpoint tail");
    appendCheckpoint(manager);
    const restored = reconstructOpenAIContext(manager.getBranch())!;
    expect(serializedSnapshot(restored.messages)).not.toContain("already summarized secret");
    expect(serializedSnapshot(restored.messages)).toContain("ordinary prior summary");
    expect(serializedSnapshot(restored.messages)).toContain("ordinary retained dialogue");
    expect(serializedSnapshot(restored.messages)).toContain("checkpoint tail");
    expect(serializedSnapshot(restored.messages)).not.toContain(OPENAI_COMPACTION_SUMMARY);
    appendUser(manager, "native retained");
    const fallback = prepareOpenAIFallback(manager.getBranch(), preparation)!;
    expect(fallback.previousSummary).toBe("ordinary prior summary");
    expect(fallback.fileOps.read.has("prior.ts")).toBe(true);
    manager.appendCompaction("superseding ordinary summary", manager.getLeafId(), 100);
    expect(reconstructOpenAIContext(manager.getBranch())).toBeUndefined();
    expect(
      repairOpenAIContext(manager.getBranch(), manager.buildSessionContext().messages)?.messages,
    ).toBeUndefined();
  });

  for (const omitSnapshots of [false])
    it(`rebuilds authoritative prompt and tools over stale checkpoint snapshots, absent=${omitSnapshots}`, () => {
      const manager = SessionManager.inMemory("/virtual/old-snapshots");
      const obsoleteSystem = {
        role: "system" as const,
        content: "opaque original",
        sections: { rules: "old" },
        toolsAdded: [{ name: "old", description: "old", parameters: { type: "object" } }],
        timestamp: 0,
      };
      const first = manager.appendMessage(obsoleteSystem);
      appendUser(manager, "first dialogue");
      appendCheckpoint(manager, first);
      manager.appendMessage({
        role: "system",
        content: "",
        sections: { rules: "current" },
        toolsRemoved: [{ name: "old" }],
        toolsAdded: [{ name: "current", description: "current", parameters: { type: "object" } }],
        timestamp: 1,
      });
      appendUser(manager, "second dialogue");
      appendCheckpoint(manager, first);
      appendUser(manager, "third dialogue");
      appendCheckpoint(manager, first);
      appendUser(manager, "otherwise safe fallback tail");
      expect(prepareOpenAIFallback(manager.getBranch(), preparation)).toBeDefined();
      const branch = Arr.map(manager.getBranch(), (entry) => {
        if (entry.type !== "compaction") return entry;
        const { systemMessage: _ignored, ...withoutSnapshot } = entry;
        return omitSnapshots
          ? withoutSnapshot
          : Object.assign({}, withoutSnapshot, { systemMessage: obsoleteSystem });
      });
      const repaired = repairOpenAIContext(branch, buildSessionContext(branch).messages)!.messages!;
      const prompt = getCurrentSystemPrompt(repaired);
      expect(Str.split(prompt, "opaque original")).toHaveLength(2);
      expect(prompt).toContain("current");
      expect(prompt).not.toContain("old");
      expect(Arr.map(getCurrentTools(repaired), (tool) => tool.name)).toEqual(["current"]);
      expect(serializedSnapshot(repaired)).toContain("first dialogue");
      expect(serializedSnapshot(repaired)).toContain("second dialogue");
      expect(prepareOpenAIFallback(branch, preparation)).toBeUndefined();
    });

  for (const editAfterCheckpoint of [true])
    it(`honors persisted omissions and replacements without mutating history, edited after checkpoint=${editAfterCheckpoint}`, () => {
      const manager = SessionManager.inMemory("/virtual/context-edits");
      manager.appendMessage({ role: "system", content: "rules", timestamp: 0 });
      const removed = appendUser(manager, "omitted user dialogue");
      const replaced = manager.appendCustomMessageEntry(
        "extension",
        "obsolete custom content",
        false,
      );
      const tool = manager.appendMessage({
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "obsolete tool content" }],
        timestamp: 2,
      });
      if (editAfterCheckpoint) appendCheckpoint(manager, removed);
      manager.appendContextEdit(removed, null);
      manager.appendContextEdit(replaced, { content: "edited custom content" });
      manager.appendContextEdit(tool, { content: "edited tool content" });
      if (!editAfterCheckpoint) appendCheckpoint(manager, removed);
      appendUser(manager, "safe retained tail");
      const branch = manager.getBranch();
      const before = serializedSnapshot(branch);
      const repaired = repairOpenAIContext(
        branch,
        manager.buildSessionContext().messages,
      )!.messages!;
      expect(serializedSnapshot(repaired)).not.toContain("omitted user dialogue");
      expect(serializedSnapshot(repaired)).not.toContain("obsolete");
      expect(serializedSnapshot(repaired)).toContain("edited custom content");
      expect(
        Option.getOrUndefined(Arr.findFirst(repaired, (message) => message.role === "toolResult"))
          ?.content,
      ).toEqual([{ type: "text", text: "edited tool content" }]);
      expect(reconstructOpenAIContext(branch)?.coverageChanged).toBe(editAfterCheckpoint);
      const fallback = prepareOpenAIFallback(branch, preparation)!;
      expect(serializedSnapshot(fallback.messagesToSummarize)).toContain("edited custom content");
      expect(serializedSnapshot(fallback.messagesToSummarize)).not.toContain("obsolete");
      expect(serializedSnapshot(branch)).toBe(before);
      const tampered = Arr.map(manager.buildSessionContext().messages, (message) =>
        message.role === "toolResult"
          ? Object.assign({}, message, { content: [{ type: "text" as const, text: "foreign" }] })
          : message,
      );
      expect(() => repairOpenAIContext(branch, tampered)).toThrow();
    });

  it("preserves complete tool results and images, and never retains an orphaned result", () => {
    const manager = history();
    manager.appendMessage(
      assistantMessage(
        [{ type: "toolCall", id: "call|fc", name: "read", arguments: { path: "body.txt" } }],
        { stopReason: "toolUse", timestamp: 4 },
      ),
    );
    appendCheckpoint(manager);
    const result = {
      role: "toolResult" as const,
      toolCallId: "call|fc",
      toolName: "read",
      isError: false,
      timestamp: 5,
      content: [
        { type: "text" as const, text: Fn.pipe("full tool result ", Str.repeat(1000)) },
        { type: "image" as const, data: "AA==", mimeType: "image/png" },
      ],
    };
    manager.appendMessage(result);
    expect(prepareOpenAIFallback(manager.getBranch(), preparation)).toBeUndefined();
    appendCheckpoint(manager);
    const repaired = repairOpenAIContext(
      manager.getBranch(),
      manager.buildSessionContext().messages,
    )!.messages!;
    expect(
      Option.getOrUndefined(Arr.findFirst(repaired, (message) => message.role === "toolResult")),
    ).toEqual(result);
    appendUser(manager, "safe retained boundary");
    const fallback = prepareOpenAIFallback(manager.getBranch(), preparation)!;
    expect(
      Option.getOrUndefined(
        Arr.findFirst(fallback.messagesToSummarize, (message) => message.role === "toolResult"),
      ),
    ).toEqual(result);
    expect(fallback.fileOps.read.has("body.txt")).toBe(true);
  });

  it("forged omission metadata cannot delete user, system, tool, successful assistant, or future tail messages", () => {
    const manager = SessionManager.inMemory("/virtual/forged-omissions");
    const systemId = manager.appendMessage({ role: "system", content: "authority", timestamp: 0 });
    const userId = appendUser(manager, "must keep user");
    const successId = appendAssistant(manager, "stop", "must keep success");
    const toolId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "must keep tool" }],
      isError: false,
      timestamp: 2,
    });
    const truncatedId = appendAssistant(manager, "length", "omitted length");
    appendCheckpoint(manager);
    const futureId = appendAssistant(manager, "length", "future length remains");
    const branch = Arr.map(manager.getBranch(), (entry) =>
      entry.type === "compaction"
        ? Object.assign({}, entry, {
            details: {
              ...details,
              checkpoint: {
                ...details.checkpoint,
                omittedEntryIds: [
                  systemId,
                  userId,
                  successId,
                  toolId,
                  truncatedId,
                  futureId,
                  "not-on-branch",
                ],
              },
            },
          })
        : entry,
    );
    const restored = reconstructOpenAIContext(branch)!;
    expect(restored.omittedEntryIds).toEqual([truncatedId]);
    for (const retained of [
      "authority",
      "must keep user",
      "must keep success",
      "must keep tool",
      "future length remains",
    ])
      expect(serializedSnapshot(restored.messages)).toContain(retained);
    expect(serializedSnapshot(restored.messages)).not.toContain("omitted length");
  });

  it("native fallback summarizes repaired history and retains only a safe post-checkpoint tail", () => {
    const manager = history();
    expect(prepareOpenAIFallback(manager.getBranch(), preparation)).toBeUndefined();
    manager.appendCustomEntry("metadata", {});
    expect(prepareOpenAIFallback(manager.getBranch(), preparation)).toBeUndefined();
    const retained = appendUser(manager, "retained tail");
    const fallback = prepareOpenAIFallback(manager.getBranch(), preparation)!;
    expect(
      Option.getOrElse(
        Arr.findFirstIndex(manager.getBranch(), (entry) => entry.id === fallback.firstKeptEntryId),
        () => -1,
      ),
    ).toBeGreaterThan(
      Option.getOrElse(
        Arr.findLastIndex(manager.getBranch(), (entry) => entry.type === "compaction"),
        () => -1,
      ),
    );
    expect(serializedSnapshot(fallback.messagesToSummarize)).toContain("original dialogue");
    expect(serializedSnapshot(fallback.messagesToSummarize)).toContain("second dialogue");
    expect(serializedSnapshot(fallback.messagesToSummarize)).not.toContain("retained tail");
    manager.appendCompaction("ordinary fallback", fallback.firstKeptEntryId, 100);
    expect(Arr.some(manager.buildContextEntries(), (entry) => entry.id === retained)).toBe(true);
    expect(reconstructOpenAIContext(manager.getBranch())).toBeUndefined();
  });
});
