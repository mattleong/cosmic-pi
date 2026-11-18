import type { ExtensionAPI, MessageRenderer, SessionEntry } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { applyPresentationSettings } from "pi-code-previews/testing";
import {
  extensionContextFixture,
  keybindingHintsFixture,
  plainTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { expect, vi } from "vitest";
import { registerSubagentMessageRenderers } from "../src/application/messages.ts";
import { QUESTION_MESSAGE_TYPE } from "../src/boundary/host-notifier.ts";
import {
  QUESTION_ANSWER_ENTRY_TYPE,
  questionAnswerReceipts,
} from "../src/boundary/host-question-rows.ts";

const questionId = "question-this-wait";
const question = "Which release should I target?";
const message = {
  role: "custom",
  customType: QUESTION_MESSAGE_TYPE,
  display: true,
  content: "Internal agent procedure",
  timestamp: 0,
  details: { version: 1, kind: "question", id: "agent-1", questionId, name: "Scout", question },
} as const;

it.effect("a mounted question row resolves at the same width and retains its question", () =>
  Effect.gen(function* () {
    const restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
    try {
      const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>();
      const host = recordingExtensionHost({}, { appendEntry });
      const answers = questionAnswerReceipts(host.pi);
      let waiting = new Set([questionId, "question-later"]);
      registerSubagentMessageRenderers(host.pi, (id) =>
        id && answers.has(id) ? "answered" : id && waiting.has(id) ? "pending" : "historical",
      );
      const render = host.messageRenderers.get(QUESTION_MESSAGE_TYPE) as MessageRenderer;
      const options = { ...keybindingHintsFixture, outputPad: 0, expanded: false };
      const row = render(message, options, plainTheme)!;
      const other = render(
        { ...message, details: { ...message.details, questionId: "question-later" } },
        options,
        plainTheme,
      )!;
      const draw = () => Arr.join(row.render(57), "\n");
      expect(draw()).toContain(question);
      answers.record(questionId);
      expect(appendEntry).toHaveBeenCalledWith(QUESTION_ANSWER_ENTRY_TYPE, { questionId });
      expect(draw()).not.toContain(question);
      expect(Arr.join(other.render(57), "\n")).toContain(question);
      const expanded = render(message, { ...options, expanded: true }, plainTheme)!;
      const details = Arr.join(expanded.render(57), "\n");
      expect(details).toContain(question);
      expect(details).not.toContain(message.content);

      // A different active branch restores only its own receipts.
      waiting = new Set();
      const before = extensionContextFixture({ sessionManager: { getBranch: () => [] } });
      yield* Effect.tryPromise(() => host.emit("session_tree", before));
      const historical = draw();
      expect(answers.has(questionId)).toBe(false);
      const receipt: SessionEntry = {
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00Z",
        customType: QUESTION_ANSWER_ENTRY_TYPE,
        data: { questionId },
      };
      const after = extensionContextFixture({ sessionManager: { getBranch: () => [receipt] } });
      yield* Effect.tryPromise(() => host.emit("session_start", after));
      expect(answers.has(questionId)).toBe(true);
      expect(draw()).not.toBe(historical);
    } finally {
      restore();
    }
  }),
);
