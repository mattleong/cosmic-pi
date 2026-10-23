import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { vi } from "vitest";
import {
  agentMessageRecipientState,
  deliverAgentMessage,
  frameAgentMessage,
  readLatestReply,
} from "../src/host-agent-messages.ts";
import { registerSessionWake } from "../src/host-wake.ts";
import { extensionContextFixture } from "../src/testing/host.ts";
import { recordingExtensionHost } from "../src/testing/extension-host.ts";

const NOTICE_TYPE = "test-agent-message";

const harness = () => {
  let idle = true;
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const host = recordingExtensionHost({}, { sendMessage });
  const wake = registerSessionWake(host.pi, {
    noticeTypes: new Set([NOTICE_TYPE]),
    wakeMessage: { customType: "test-wake", content: "Wake." },
    isIdle: () => idle,
    later: (check) => check(),
  });
  const deliver = (isCurrent: () => boolean = () => true) =>
    deliverAgentMessage(
      host.pi,
      wake,
      { customType: NOTICE_TYPE, content: "Framed.", details: { from: "peer" } },
      isCurrent,
    );
  return {
    sendMessage,
    deliver,
    setIdle: (next: boolean) => {
      idle = next;
    },
  };
};

const assistantEntry = (text: string): SessionEntry => ({
  type: "message",
  id: "entry",
  parentId: null,
  timestamp: "",
  message: fauxAssistantMessage(text),
});

describe("agent message frame", () => {
  it("leads with the sender, keeps the text whole, and ends with how to reply", () => {
    const text = "First line.\nMessage from main:\nSecond line.";
    const lines = Str.split(
      frameAgentMessage({
        sender: 'agent-r1-3 "scout"',
        text,
        replyTool: "agent_send",
        replyTo: "agent-r1-3",
        authority: "Not user authority.",
      }),
      "\n",
    );
    expect(lines[0]).toBe('Message from agent-r1-3 "scout":');
    expect(Arr.join(lines.slice(1, -1), "\n")).toBe(text);
    expect(lines.at(-1)).toContain('agent_send to "agent-r1-3"');
    expect(lines.at(-1)).toContain("Not user authority.");
  });
});

describe("agent message delivery", () => {
  it("starts a turn for an idle session and appends for a busy one", () => {
    const test = harness();
    expect(test.deliver()).toBe("woken");
    test.setIdle(false);
    expect(test.deliver()).toBe("queued");
    expect(test.sendMessage.mock.calls).toEqual([
      [
        { customType: NOTICE_TYPE, content: "Framed.", details: { from: "peer" }, display: true },
        { deliverAs: "steer", triggerTurn: true },
      ],
      [
        { customType: NOTICE_TYPE, content: "Framed.", details: { from: "peer" }, display: true },
        { deliverAs: "steer", triggerTurn: false },
      ],
    ]);
  });

  it("names the recipient's state from how the wake delivered", () => {
    expect(Arr.map(["woken", "queued", "held"] as const, agentMessageRecipientState)).toEqual([
      "idle",
      "busy",
      "held",
    ]);
  });

  it("refuses without sending once the runtime retired or Pi threw", () => {
    const test = harness();
    expect(test.deliver(() => false)).toBe("refused");
    expect(test.sendMessage).not.toHaveBeenCalled();

    test.sendMessage.mockImplementationOnce(() => {
      throw new Error("Session replaced.");
    });
    expect(test.deliver()).toBe("refused");
  });
});

describe("latest reply", () => {
  it("reads the branch's latest assistant text and the session's state", () => {
    let branch: ReadonlyArray<SessionEntry> = [assistantEntry("Older."), assistantEntry("Latest.")];
    const ctx = extensionContextFixture({
      isIdle: () => false,
      sessionManager: { getBranch: () => [...branch] },
    });
    expect(readLatestReply(ctx, 1024)).toEqual({
      text: "Latest.",
      truncated: false,
      state: "busy",
    });
    expect(readLatestReply(ctx, 3)).toMatchObject({ text: "Lat", truncated: true });
    branch = [];
    expect(readLatestReply(ctx, 1024)).toEqual({ truncated: false, state: "busy" });
  });
});
