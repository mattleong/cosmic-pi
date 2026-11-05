import { applyPresentationSettings, captureRegistrations } from "pi-code-previews/testing";
import { keybindingHintsFixture, extensionApiFixture, plainTheme } from "pi-cosmic-core/testing";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import {
  registerSubagentMessageRenderers,
  renderSubagentMessage,
} from "../src/application/messages.ts";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

let restore = () => {};
afterEach(() => restore());

test.each(["compact", "preview"] as const)(
  "registered %s notifications show agents' words and hide agent procedures without changing their delivered content",
  (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
    const renderers = captureRegistrations(registerSubagentMessageRenderers).messageRenderers;
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const notify = hostNotifier(extensionApiFixture({ sendMessage }));
    notify({
      type: "completed",
      runs: [
        {
          id: "PRIVATE_RUN_ID",
          name: "Worker",
          generation: 1,
          outcome: "failed",
          error: "PRIVATE_STACK_TRACE",
          nextCandidate: { model: "openai/next", effort: "high" },
        },
        {
          id: "PRIVATE_RUN_ID_WRITER",
          name: "Writer",
          generation: 1,
          outcome: "completed",
          finalText: "Done.",
          workspaceOutcome: { status: "proposal", changedFileCount: 2 },
        },
      ],
    });
    notify({
      type: "question",
      id: "PRIVATE_RUN_ID",
      name: "Worker",
      requestId: "PRIVATE_REQUEST",
      generation: 1,
      message: "AGENT_QUESTION",
    });
    for (const [message] of sendMessage.mock.calls) {
      const before = JSON.stringify(message);
      expect(renderers.has(message.customType)).toBe(true);
      const render = renderSubagentMessage;
      expect(message.content).toContain("PRIVATE_RUN_ID");
      for (const expanded of [false, true, false, true]) {
        const component = render(
          { ...message, role: "custom", timestamp: 0 },
          { ...keybindingHintsFixture, expanded, outputPad: 0 },
          plainTheme,
        );
        const text = Arr.join(component!.render(180), "\n");
        expect(Fn.pipe(text, Str.includes("PRIVATE_RUN_ID"))).toBe(expanded);
        // What agents wrote stays readable collapsed, as tool rows keep their output.
        expect(
          Fn.pipe(
            text,
            Str.includes(
              message.customType === "pi-subagents-completed"
                ? "PRIVATE_STACK_TRACE"
                : "AGENT_QUESTION",
            ),
          ),
        ).toBe(true);
        if (!expanded) expect(text).not.toMatch(/agent_send|agent_lifecycle|agent_worktree/);
        expect(JSON.stringify(message)).toBe(before);
      }
      const history = render(
        { ...message, details: undefined, role: "custom", timestamp: 0 },
        { ...keybindingHintsFixture, expanded: true, outputPad: 0 },
        plainTheme,
      );
      expect(Arr.join(history!.render(180), "\n")).toContain("PRIVATE_RUN_ID");
    }
  },
);

test.each(["compact", "preview"] as const)(
  "%s notifications label an agent's words beneath an expanded heading that wraps",
  (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const notify = hostNotifier(extensionApiFixture({ sendMessage }));
    const name = "billing-and-invoicing-migration-review-follow-up-for-the-legacy-ledger-export-v2";
    notify({
      type: "completed",
      runs: [
        {
          id: "agent-2",
          name,
          generation: 1,
          outcome: "completed",
          finalText: "Found 3 stale references.",
        },
      ],
    });
    notify({
      type: "question",
      id: "agent-6",
      name,
      requestId: "q-1",
      generation: 1,
      message: "Should I leave it for a follow-up?",
    });
    const labels = Arr.map(sendMessage.mock.calls, ([message]) => (width: number) => {
      const component = renderSubagentMessage(
        { ...message, role: "custom", timestamp: 0 },
        { ...keybindingHintsFixture, expanded: true, outputPad: 0 },
        plainTheme,
      );
      return Arr.filter(Arr.map(component?.render(width) ?? [], Str.trim), (row) =>
        Arr.contains(["Report", "Question"], row),
      );
    });
    const [report, question] = labels;
    expect(report?.(57)).toEqual(["Report"]);
    expect(question?.(57)).toEqual(["Question"]);
    // A heading that fits on one row leaves the words unlabeled.
    expect(report?.(180)).toEqual([]);
    expect(question?.(180)).toEqual([]);
  },
);
