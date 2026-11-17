import {
  initTheme,
  type KeybindingsManager,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";
import { stripAnsi } from "pi-cosmic-core";
import { piKeybindingsFixture, plainTheme, tuiFixture } from "pi-cosmic-core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  transcriptMessage,
  type TranscriptMessage,
} from "../../src/boundary/session-transcript.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { SessionTranscript } from "../../src/ui/session-transcript.ts";
import { sessionSubmitKind, SubagentSessionView } from "../../src/ui/session-view.ts";
import { view as runView } from "../fixtures/run-view.ts";

beforeAll(() => initTheme("dark", false));

const assistant = (content: ReadonlyArray<Schema.Json>, stopReason = "toolUse"): Schema.Json => ({
  role: "assistant",
  content,
  stopReason,
  timestamp: 0,
});
const toolCall = (id: string, command: string): Schema.Json => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: { command },
});
const saved = (...messages: ReadonlyArray<Schema.Json>): ReadonlyArray<TranscriptMessage> =>
  Arr.filter(Arr.map(messages, transcriptMessage), (message) => message !== undefined);

const renderers: ToolRenderers = {
  renderCall: (args) => new Text(`CALL ${JSON.stringify(args)}`, 0, 0),
  renderResult: (result) =>
    new Text(
      `RESULT ${Arr.join(
        Arr.map(result.content, (part) => (part.type === "text" ? part.text : "")),
        "",
      )}`,
      0,
      0,
    ),
};

const transcriptFixture = () => {
  const asked: string[] = [];
  const transcript = new SessionTranscript({
    tui: tuiFixture(),
    cwd: "/project",
    toolRenderers: (name) => {
      asked.push(name);
      return name === "bash" ? renderers : undefined;
    },
    messageRenderer: () => undefined,
  });
  const text = () => stripAnsi(Arr.join(transcript.render(100), "\n"));
  return { transcript, text, asked };
};

describe("a subagent's transcript", () => {
  it("draws the saved conversation, with each result on its own call", () => {
    const { transcript, text } = transcriptFixture();
    transcript.reset(
      saved(
        { role: "user", content: "Review auth", timestamp: 0 },
        assistant([{ type: "text", text: "Looking" }, toolCall("t1", "ls"), toolCall("t2", "pwd")]),
        {
          role: "toolResult",
          toolCallId: "t2",
          toolName: "bash",
          content: [{ type: "text", text: "/project" }],
          isError: false,
          timestamp: 0,
        },
      ),
      false,
    );
    const shown = text();
    expect(shown).toContain("Review auth");
    expect(shown).toContain("Looking");
    expect(shown).toMatch(/"command":"ls"[\s\S]*"command":"pwd"/);
    expect(shown).toContain("RESULT /project");
    expect(transcript.working).toBe(false);
  });

  it("follows a live turn from its events and reports a compaction as stale", () => {
    const { transcript, text } = transcriptFixture();
    transcript.reset(saved({ role: "user", content: "task", timestamp: 0 }), true);
    const partial = assistant([{ type: "text", text: "Checking" }, toolCall("t1", "ls")]);
    // The start of this message came before the snapshot; its update alone must draw it.
    expect(transcript.apply({ type: "message_update", message: partial })).toBe("applied");
    expect(transcript.working).toBe(true);
    transcript.apply({ type: "message_end", message: partial });
    transcript.apply({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    transcript.apply({
      type: "tool_execution_end",
      toolCallId: "t1",
      result: { content: [{ type: "text", text: "a.ts" }] },
      isError: false,
    });
    transcript.apply({
      type: "message_start",
      message: { role: "user", content: "also b", timestamp: 0 },
    });
    transcript.apply({ type: "agent_end" });
    const shown = text();
    expect(shown).toContain("Checking");
    expect(shown).toContain('CALL {"command":"ls"}');
    expect(shown).toContain("RESULT a.ts");
    expect(shown).toContain("also b");
    expect(transcript.working).toBe(false);
    expect(transcript.userMessageCount).toBe(2);
    expect(transcript.apply({ type: "compaction_end" })).toBe("stale");
  });

  it("keeps drawing after an event or message it can't read", () => {
    const { transcript, text } = transcriptFixture();
    transcript.reset(saved({ role: "assistant", content: "not parts", stopReason: "stop" }), false);
    transcript.apply({
      type: "tool_execution_end",
      toolCallId: "missing",
      result: 7,
      isError: false,
    });
    transcript.apply({
      type: "message_start",
      message: { role: "user", content: "still here", timestamp: 0 },
    });
    expect(text()).toContain("still here");
  });

  it("marks a live snapshot's unanswered call as running and asks once per drawn call", () => {
    const { transcript, asked } = transcriptFixture();
    transcript.reset(saved(assistant([toolCall("t1", "sleep 5")])), true);
    expect(transcript.working).toBe(true);
    expect(asked).toEqual(["bash"]);
  });
});

const ESC = "\u001b";
const CTRL_D = "\u0004";
const KEYS = new Map([
  ["app.interrupt", ESC],
  ["app.exit", CTRL_D],
]);

const viewFixture = (initial: Partial<SubagentRunView> = {}) => {
  let run: SubagentRunView | undefined = runView(initial);
  const calls: string[] = [];
  const tui = tuiFixture();
  const { transcript } = transcriptFixture();
  const keybindings: KeybindingsManager = piKeybindingsFixture({
    matches: (data, id) => KEYS.get(id) === data,
  });
  const screen = new SubagentSessionView({
    tui,
    theme: plainTheme,
    keybindings,
    getHeight: () => 20,
    getNow: () => 10_000,
    transcript,
    getRun: () => run,
    onSubmit: (text) => calls.push(`submit:${text}`),
    onInterrupt: () => calls.push("interrupt"),
    onLeave: () => calls.push("leave"),
  });
  screen.focused = true;
  const type = (text: string) => {
    for (const key of text) screen.handleInput(key);
  };
  return {
    screen,
    transcript,
    calls,
    type,
    setRun: (next: Partial<SubagentRunView> | undefined) => {
      run = next && runView(next);
    },
    text: () => stripAnsi(Arr.join(screen.render(80), "\n")),
  };
};

describe("a subagent's session screen", () => {
  it("interrupts a working run with Esc and leaves an idle one", () => {
    const h = viewFixture({ state: "running" });
    h.screen.handleInput(ESC);
    h.setRun({ state: "completed" });
    h.screen.handleInput(ESC);
    h.setRun(undefined);
    h.screen.handleInput(ESC);
    expect(h.calls).toEqual(["interrupt", "leave", "leave"]);
  });

  it("leaves on the exit key only while the editor is empty", () => {
    const h = viewFixture({ state: "running" });
    h.type("draft");
    h.screen.handleInput(CTRL_D);
    expect(h.calls).toEqual([]);
    h.type("\r");
    h.screen.handleInput(CTRL_D);
    expect(h.calls).toEqual(["submit:draft", "leave"]);
  });

  it("shows a sent message as queued until the conversation shows it or delivery fails", () => {
    const h = viewFixture({ state: "running" });
    h.screen.markLoaded();
    h.type("first\r");
    h.type("second\r");
    expect(h.text()).toContain("Steering: first");
    h.transcript.apply({
      type: "message_start",
      message: { role: "user", content: "first", timestamp: 0 },
    });
    expect(h.text()).not.toContain("Steering: first");
    expect(h.text()).toContain("Steering: second");
    h.screen.restoreDraft("second");
    expect(h.text()).not.toContain("Steering:");
    expect(h.text()).toContain("second");
  });

  it("shows its working status and footer like Pi's own, and neither once the run is idle", () => {
    const usage = { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0, totalTokens: 1540 };
    const h = viewFixture({ state: "running", startedAt: 4_000, usage, cwd: "/project/web" });
    h.screen.markLoaded();
    const working = h.text();
    expect(working).toMatch(/── \S Working · 6s ─/u);
    expect(working).toContain("gpt-5.6-sol");
    expect(working).toContain("/project/web");
    expect(working).toContain("↑1.2k");
    h.setRun({ state: "completed", usage, endedAt: 9_000 });
    expect(h.text()).not.toContain("Working");
    expect(h.text()).toContain("↑1.2k");
  });

  it("queues neither a reply, which answers the run's question, nor a resume", () => {
    const question = { requestId: "q1", message: "Which colour?" };
    const h = viewFixture({ state: "waiting_for_parent", question });
    h.screen.markLoaded();
    h.type("blue\r");
    h.setRun({ state: "completed" });
    h.type("continue\r");
    expect(h.calls).toEqual(["submit:blue", "submit:continue"]);
    expect(h.text()).not.toContain("Steering:");
  });

  it("always fills its height, whatever the transcript holds", () => {
    const h = viewFixture({ state: "running" });
    expect(h.screen.render(80)).toHaveLength(20);
    h.transcript.reset(
      saved(
        ...Arr.makeBy(40, (index) => ({ role: "user", content: `line ${index}`, timestamp: 0 })),
      ),
      false,
    );
    const rows = h.screen.render(80);
    expect(rows).toHaveLength(20);
    expect(stripAnsi(Arr.join(rows, "\n"))).toContain("line 39");
  });

  it("names what Enter does by the run's state", () => {
    expect(sessionSubmitKind(runView({ state: "running" }))).toBe("send");
    expect(sessionSubmitKind(runView({ state: "starting" }))).toBe("send");
    expect(sessionSubmitKind(runView({ state: "waiting_for_parent" }))).toBe("reply");
    for (const state of ["paused", "completed", "failed", "stopped"] as const)
      expect(sessionSubmitKind(runView({ state }))).toBe("resume");
  });
});
