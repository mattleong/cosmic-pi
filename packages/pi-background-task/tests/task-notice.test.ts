import type {
  AgentBeforeSettleEvent,
  BoundaryContextPreview,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { it as effectIt } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { applyPresentationSettings } from "pi-code-previews/testing";
import {
  extensionContextFixture,
  plainTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerSubagentTaskNoticeDelivery,
  taskNoticeContent,
} from "../src/boundary/host-notice.ts";
import type { BackgroundTaskNotice } from "../src/task/model.ts";
import {
  TASK_NOTICE_MESSAGE_TYPE,
  taskNoticeDetails,
  type TaskNoticeDetails,
} from "../src/task/notice.ts";
import { renderTaskNotice } from "../src/ui/notice-message.ts";
import { taskLogSlice, taskStatus } from "./support/task-service-double.ts";

type ContextMessage = BoundaryContextPreview["contextMessages"][number];

const failed = taskStatus({
  id: "task-0000000001",
  name: "tests",
  command: "API_KEY=FAKE_SECRET_123 pnpm test",
  state: "failed",
  startedAt: 1_000,
  endedAt: 124_000,
  exitCode: 1,
  failureCause: "FAIL tests/auth.test.ts > rejects expired tokens",
});

const failedNotice: BackgroundTaskNotice = {
  task: failed,
  recent: taskLogSlice(failed.id, "failed", [
    { stream: "stdout", text: "token=FAKE_SECRET_456\n" },
    { stream: "stderr", text: " FAIL tests/auth.test.ts > rejects expired tokens\n" },
  ]),
  retained: true,
};

let restore = () => {};
afterEach(() => restore());

describe("background task exit notices", () => {
  it("names the task, how it ended, and its newest output, without credentials", () => {
    const content = taskNoticeContent(failedNotice);
    for (const fact of [failed.id, "tests", "exit code 1", "2m 3s", "[stderr]  FAIL", "logs"])
      expect(content).toContain(fact);
    expect(content).not.toContain("FAKE_SECRET");
  });

  it("points to logs only while the task's record is still listed", () => {
    const readLogs = `action "logs"`;
    expect(taskNoticeContent(failedNotice)).toContain(readLogs);
    const cleared = taskNoticeContent({ ...failedNotice, retained: false });
    expect(cleared).not.toContain(readLogs);
    expect(cleared).toContain("rejects expired tokens");
  });

  it("repeats only the newest output of a long-running task", () => {
    const lines = Arr.makeBy(400, (index) => ({
      stream: "stdout" as const,
      text: `line ${index} ${Fn.pipe("x", Str.repeat(60))}\n`,
    }));
    const { failureCause: _cause, ...task } = failed;
    const content = taskNoticeContent({
      task: { ...task, state: "exited", exitCode: 0 },
      recent: taskLogSlice(failed.id, "exited", lines.slice(-20)),
      retained: true,
    });
    expect(content).toContain("line 399 ");
    expect(content).not.toContain("line 300 ");
    expect(content.length).toBeLessThan(6_000);
  });
});

// Stored details, including shapes this renderer can't read.
type StoredNoticeDetails =
  | TaskNoticeDetails
  | { readonly task: Pick<TaskNoticeDetails["task"], "id"> }
  | string
  | undefined;

const renderNotice = (details: StoredNoticeDetails, expanded: boolean, content: string) =>
  Arr.join(
    renderTaskNotice(
      {
        role: "custom",
        timestamp: 0,
        customType: TASK_NOTICE_MESSAGE_TYPE,
        display: true,
        content,
        details,
      },
      { expanded, outputPad: 0 },
      plainTheme,
    )?.render(120) ?? [],
    "\n",
  );

describe("background task notice rendering", () => {
  it.each(["compact", "preview"] as const)(
    "renders a %s notice whose details can't be read, keeping its message for expansion",
    (style) => {
      restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
      const content = taskNoticeContent(failedNotice);
      for (const details of [undefined, { task: { id: failed.id } }, "not details"]) {
        const collapsed = renderNotice(details, false, content);
        expect(collapsed).not.toBe("");
        expect(collapsed).not.toContain("rejects expired tokens");
        expect(renderNotice(details, true, content)).toContain("rejects expired tokens");
      }
      expect(renderNotice(taskNoticeDetails(failed), false, content)).toContain("tests");
    },
  );
});

const contextNotice = (): ContextMessage => ({
  role: "custom",
  customType: TASK_NOTICE_MESSAGE_TYPE,
  content: "A task finished.",
  display: true,
  timestamp: 0,
});

const settleEvent = (
  contextMessages: ReadonlyArray<ContextMessage>,
  pendingMessages: ReadonlyArray<ContextMessage> = [],
  outcome: AgentBeforeSettleEvent["outcome"] = "completed",
): AgentBeforeSettleEvent => ({
  type: "agent_before_settle",
  outcome,
  entries: [],
  continue: false,
  context: {
    contextEntries: [],
    contextMessages: [...contextMessages],
    llmMessages: [],
    pendingMessages: [...pendingMessages],
    canContinue: true,
  },
});

const subagentHarness = () => {
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const host = recordingExtensionHost({}, { sendMessage });
  const deliver = registerSubagentTaskNoticeDelivery(host.pi);
  const ctx = extensionContextFixture({});
  const settle = (event: AgentBeforeSettleEvent) =>
    Effect.promise(() =>
      Promise.resolve(host.handlers.get("agent_before_settle")[0]?.(event, ctx)),
    );
  return { sendMessage, deliver, settle };
};

describe("background task notices in a subagent session", () => {
  effectIt.effect(
    "never starts a turn, but continues a settling run until the notice is answered",
    () =>
      Effect.gen(function* () {
        const test = subagentHarness();
        test.deliver(failedNotice, () => true);
        test.deliver(failedNotice, () => false);
        expect(test.sendMessage).toHaveBeenCalledTimes(1);
        const [message, options] = test.sendMessage.mock.calls[0] ?? [];
        expect(message).toMatchObject({
          customType: TASK_NOTICE_MESSAGE_TYPE,
          details: { task: { id: failed.id } },
        });
        expect(options?.triggerTurn).toBe(false);

        const reply = fauxAssistantMessage("Done.");
        const notice = contextNotice();
        expect(yield* test.settle(settleEvent([reply], [notice]))).toMatchObject({
          continue: true,
        });
        expect(yield* test.settle(settleEvent([reply, notice]))).toMatchObject({ continue: true });
        expect(yield* test.settle(settleEvent([notice, reply]))).toBeUndefined();
        expect(yield* test.settle(settleEvent([reply, notice], [], "aborted"))).toBeUndefined();
      }),
  );
});
