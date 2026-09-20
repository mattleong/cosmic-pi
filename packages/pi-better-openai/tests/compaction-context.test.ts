import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerBetterOpenAIApplication } from "../src/application.ts";
import {
  hasExactPrefix,
  reconstructOpenAIContext,
  repairOpenAIContext,
} from "../src/compaction/context.ts";
import { prepareOpenAIFallback } from "../src/compaction/fallback.ts";
import {
  OPENAI_COMPACTION_DETAILS_TYPE,
  OPENAI_COMPACTION_SUMMARY,
} from "../src/compaction/protocol.ts";

const details = {
  type: OPENAI_COMPACTION_DETAILS_TYPE,
  checkpoint: {
    version: 1,
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.5",
    output: [{ type: "compaction", encrypted_content: "encrypted" }],
    rawInputCount: 999,
    createdAt: 0,
    tokensBefore: 100,
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
const text = <Value>(value: Value) => JSON.stringify(value);
const appendUser = (manager: SessionManager, content: string) =>
  manager.appendMessage({ role: "user", content, timestamp: 1 });
const appendCheckpoint = (manager: SessionManager, retained = manager.getLeafId()!) =>
  manager.appendCompaction(OPENAI_COMPACTION_SUMMARY, retained, 100, details, true);

const appendAssistant = (
  manager: SessionManager,
  stopReason: "error" | "length" | "stop",
  content: string,
) =>
  manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    stopReason,
    content: [{ type: "text", text: content }],
    timestamp: 10,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

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
    const handlers = new Map<string, ExtensionHandler<any, any>>();
    const registration = {
      on: (event: string, handler: ExtensionHandler<any, any>) => {
        handlers.set(event, handler);
      },
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn() },
    };
    // SAFETY: Registration only uses these host methods; no runtime is started.
    registerBetterOpenAIApplication(registration as typeof registration & ExtensionAPI);
    const host = { sessionManager: history(), abort: vi.fn(), ui: { notify: vi.fn() } };
    // SAFETY: Inactive-runtime context/compaction admission only uses these members.
    const ctx = host as typeof host & ExtensionContext;
    handlers.get("context")!(
      { type: "context", messages: host.sessionManager.buildSessionContext().messages },
      ctx,
    );
    expect(host.abort).toHaveBeenCalledOnce();
    expect(host.ui.notify).toHaveBeenCalled();
    expect(handlers.get("session_before_compact")!({}, ctx)).toEqual({ cancel: true });
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
    const before = text(branch);
    const restored = reconstructOpenAIContext(branch)!;
    expect(text(restored.messages)).toContain("original dialogue");
    expect(text(restored.messages)).toContain("second dialogue");
    expect(text(restored.messages)).toContain("tail dialogue");
    expect(text(restored.messages)).not.toContain(OPENAI_COMPACTION_SUMMARY);
    expect(restored.messages.filter((message) => message.role === "system")).toHaveLength(2);
    expect(text(restored.coveredEntries)).not.toContain("tail dialogue");
    expect(text(restored.coveredEntries)).not.toContain("tail instruction");
    expect(text(branch)).toBe(before);
  });

  it("preserves an extension's non-session tail and rejects a modified native prefix", () => {
    const manager = history();
    const native = manager.buildSessionContext().messages;
    const tail = { role: "user" as const, content: "extension addition", timestamp: 5 };
    const repaired = repairOpenAIContext(manager.getBranch(), [...native, tail])!.messages!;
    expect(repaired.at(-1)).toBe(tail);
    expect(text(repaired)).toContain("original dialogue");
    expect(() => repairOpenAIContext(manager.getBranch(), [tail, ...native])).toThrow();
  });

  it("reads old v1 retention, keeps parent anchors and stops at preceding ordinary Pi compaction", () => {
    const manager = SessionManager.inMemory("/virtual/legacy");
    appendUser(manager, "already summarized secret");
    const retained = appendUser(manager, "ordinary retained dialogue");
    manager.appendCompaction("ordinary prior summary", retained, 100, {
      readFiles: ["prior.ts"],
      modifiedFiles: [],
    });
    appendCheckpoint(manager, retained);
    const oldCheckpoint = manager.getLeafId()!;
    appendUser(manager, "legacy tail");
    appendCheckpoint(manager, oldCheckpoint);
    const restored = reconstructOpenAIContext(manager.getBranch())!;
    expect(text(restored.messages)).not.toContain("already summarized secret");
    expect(text(restored.messages)).toContain("ordinary prior summary");
    expect(text(restored.messages)).toContain("ordinary retained dialogue");
    expect(text(restored.messages)).toContain("legacy tail");
    expect(text(restored.messages)).not.toContain(OPENAI_COMPACTION_SUMMARY);
    appendUser(manager, "native retained");
    const fallback = prepareOpenAIFallback(manager.getBranch(), preparation)!;
    expect(fallback.previousSummary).toBe("ordinary prior summary");
    expect(fallback.fileOps.read.has("prior.ts")).toBe(true);
    manager.appendCompaction("superseding ordinary summary", manager.getLeafId()!, 100);
    expect(reconstructOpenAIContext(manager.getBranch())).toBeUndefined();
    expect(
      repairOpenAIContext(manager.getBranch(), manager.buildSessionContext().messages)?.messages,
    ).toBeUndefined();
  });

  it("compares JSON-equivalent prefixes without depending on optional fields or key order", () => {
    expect(
      hasExactPrefix(
        [{ content: "same", role: "user" }],
        [{ role: "user", content: "same", omitted: undefined }],
      ),
    ).toBe(true);
    expect(
      hasExactPrefix([{ role: "user", content: "changed" }], [{ role: "user", content: "same" }]),
    ).toBe(false);
  });

  for (const omitSnapshots of [false, true])
    it(`rebuilds authoritative prompt and tools for old v1 snapshots, absent=${omitSnapshots}`, () => {
      const manager = SessionManager.inMemory("/virtual/old-snapshots");
      const first = manager.appendMessage({
        role: "system",
        content: "opaque original",
        sections: { rules: "old" },
        toolsAdded: [{ name: "old", description: "old", parameters: { type: "object" } }],
        timestamp: 0,
      });
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
      const branch = manager.getBranch().map((entry) => {
        if (entry.type !== "compaction" || !omitSnapshots) return entry;
        const { systemMessage: _ignored, ...legacy } = entry;
        return legacy;
      });
      const repaired = repairOpenAIContext(branch, buildSessionContext(branch).messages)!.messages!;
      const prompt = getCurrentSystemPrompt(repaired);
      expect(prompt.split("opaque original")).toHaveLength(2);
      expect(prompt).toContain("current");
      expect(prompt).not.toContain("old");
      expect(getCurrentTools(repaired).map((tool) => tool.name)).toEqual(["current"]);
      expect(text(repaired)).toContain("first dialogue");
      expect(text(repaired)).toContain("second dialogue");
      // Pi would persist its unfiltered, obsolete system state on ordinary fallback.
      expect(prepareOpenAIFallback(branch, preparation)).toBeUndefined();
    });

  it("preserves complete tool results and images, and never retains an orphaned result", () => {
    const manager = history();
    manager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "toolCall", id: "call|fc", name: "read", arguments: { path: "body.txt" } }],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 4,
    });
    appendCheckpoint(manager);
    const result = {
      role: "toolResult" as const,
      toolCallId: "call|fc",
      toolName: "read",
      isError: false,
      timestamp: 5,
      content: [
        { type: "text" as const, text: "full tool result ".repeat(1000) },
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
    expect(repaired.find((message) => message.role === "toolResult")).toEqual(result);
    appendUser(manager, "safe retained boundary");
    const fallback = prepareOpenAIFallback(manager.getBranch(), preparation)!;
    expect(fallback.messagesToSummarize.find((message) => message.role === "toolResult")).toEqual(
      result,
    );
    expect(fallback.fileOps.read.has("body.txt")).toBe(true);
  });

  it("observes only native retry omissions and honors later native reappearance or branch replacement", () => {
    const manager = SessionManager.inMemory("/virtual/plain-retry");
    appendUser(manager, "question");
    const failedId = appendAssistant(manager, "error", "503 failed");
    const observed = repairOpenAIContext(
      manager.getBranch(),
      manager.buildSessionContext().messages.slice(0, -1),
    )!;
    expect(observed.omittedEntryIds).toEqual([failedId]);
    expect(observed.messages).toBeUndefined();
    appendAssistant(manager, "stop", "successful retry");
    const withoutError = manager
      .buildSessionContext()
      .messages.filter((message) => message.role !== "assistant" || message.stopReason !== "error");
    expect(
      repairOpenAIContext(manager.getBranch(), withoutError, observed.omittedEntryIds)
        ?.omittedEntryIds,
    ).toEqual([failedId]);
    expect(
      repairOpenAIContext(
        manager.getBranch(),
        manager.buildSessionContext().messages,
        observed.omittedEntryIds,
      )?.omittedEntryIds,
    ).toEqual([]);
    const other = SessionManager.inMemory("/virtual/other-branch");
    appendUser(other, "other question");
    expect(
      repairOpenAIContext(
        other.getBranch(),
        other.buildSessionContext().messages,
        observed.omittedEntryIds,
      )?.omittedEntryIds,
    ).toEqual([]);
    appendCheckpoint(manager);
    expect(() => repairOpenAIContext(manager.getBranch(), [], observed.omittedEntryIds)).toThrow();
  });

  it("invalidates encrypted coverage when a newly observed omission changes covered conversation", () => {
    const manager = history();
    const truncatedId = appendAssistant(manager, "length", "truncated response");
    appendCheckpoint(manager);
    const runtime = manager
      .buildSessionContext()
      .messages.filter(
        (message) => message.role !== "assistant" || message.stopReason !== "length",
      );
    const repaired = repairOpenAIContext(manager.getBranch(), runtime)!;
    expect(text(repaired.messages)).not.toContain("truncated response");
    const restored = reconstructOpenAIContext(manager.getBranch(), repaired.omittedEntryIds)!;
    expect(restored.omittedEntryIds).toContain(truncatedId);
    expect(restored.coverageChanged).toBe(true);
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
    const branch = manager.getBranch().map((entry) =>
      entry.type === "compaction"
        ? {
            ...entry,
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
          }
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
      expect(text(restored.messages)).toContain(retained);
    expect(text(restored.messages)).not.toContain("omitted length");
  });

  it("native fallback summarizes repaired history and retains only a safe post-checkpoint tail", () => {
    const manager = history();
    expect(prepareOpenAIFallback(manager.getBranch(), preparation)).toBeUndefined();
    manager.appendCustomEntry("metadata", {});
    expect(prepareOpenAIFallback(manager.getBranch(), preparation)).toBeUndefined();
    const retained = appendUser(manager, "retained tail");
    const fallback = prepareOpenAIFallback(manager.getBranch(), preparation)!;
    expect(
      manager.getBranch().findIndex((entry) => entry.id === fallback.firstKeptEntryId),
    ).toBeGreaterThan(manager.getBranch().findLastIndex((entry) => entry.type === "compaction"));
    expect(text(fallback.messagesToSummarize)).toContain("original dialogue");
    expect(text(fallback.messagesToSummarize)).toContain("second dialogue");
    expect(text(fallback.messagesToSummarize)).not.toContain("retained tail");
    manager.appendCompaction("ordinary fallback", fallback.firstKeptEntryId, 100);
    expect(manager.buildContextEntries().some((entry) => entry.id === retained)).toBe(true);
    expect(reconstructOpenAIContext(manager.getBranch())).toBeUndefined();
  });
});
