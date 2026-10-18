import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { latestAssistantText } from "../src/host-transcript.ts";

const entry = (message: Extract<SessionEntry, { type: "message" }>["message"]): SessionEntry => ({
  type: "message",
  id: "entry",
  parentId: null,
  timestamp: "",
  message,
});

const assistant = (...args: Parameters<typeof fauxAssistantMessage>): SessionEntry =>
  entry(fauxAssistantMessage(...args));

const user = (text: string): SessionEntry =>
  entry({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

describe("latest assistant text", () => {
  it("joins the text parts of the latest assistant message on the branch", () => {
    const latest = assistant([
      { type: "thinking", thinking: "Hidden reasoning." },
      { type: "text", text: "First part. " },
      { type: "text", text: "Second part." },
    ]);
    const branch = [assistant("Older reply."), latest, user("Hi")];
    expect(latestAssistantText(branch, 1024)).toEqual({
      text: "First part. Second part.",
      truncated: false,
    });
  });

  it("skips an aborted message without content", () => {
    const branch = [assistant("Kept reply."), assistant([], { stopReason: "aborted" })];
    expect(latestAssistantText(branch, 1024)?.text).toBe("Kept reply.");
  });

  it("bounds the text in UTF-8 bytes without splitting a character", () => {
    const branch = [assistant("ab🌌cd")];
    expect(latestAssistantText(branch, 5)).toEqual({ text: "ab", truncated: true });
    expect(latestAssistantText(branch, 6)).toEqual({ text: "ab🌌", truncated: true });
  });

  it("is undefined without an assistant message", () => {
    expect(latestAssistantText([user("Hello")], 1024)).toBeUndefined();
  });
});
