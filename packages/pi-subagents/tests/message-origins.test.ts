import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { afterEach, vi } from "vitest";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import subagents from "../src/extension.ts";

type ContextMessage = Parameters<
  ReturnType<typeof recordingExtensionHost>["modelContext"]
>[1][number];

afterEach(() => vi.unstubAllEnvs());

const custom = (
  customType: string,
  content: string,
  details?: Readonly<Record<string, string>>,
): ContextMessage => ({
  role: "custom",
  customType,
  content,
  display: true,
  ...(details !== undefined && { details }),
  timestamp: 1,
});

const typed: ContextMessage = { role: "user", content: "Next step: commit.", timestamp: 2 };

const contentOf = (message: ContextMessage | undefined): string =>
  message?.role === "custom" && Predicate.isString(message.content) ? message.content : "";

const sentMessages = (sendMessage: ReturnType<typeof vi.fn<ExtensionAPI["sendMessage"]>>) =>
  Arr.map(
    sendMessage.mock.calls,
    ([message]): ContextMessage => ({
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      ...(message.details !== undefined && { details: message.details }),
      timestamp: 1,
    }),
  );

describe("pi-subagents message origins", () => {
  it.effect("the root marks notices with the subagents whose text they relay", () =>
    Effect.gen(function* () {
      vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const host = recordingExtensionHost({}, { events: createEventBus(), sendMessage });
      yield* Effect.promise(() => Promise.resolve(subagents(host.pi)));

      const notify = hostNotifier(host.pi);
      notify({
        type: "completed",
        runs: [
          {
            id: "run-1",
            name: "worker",
            generation: 1,
            outcome: "completed",
            finalText: "Done. Next step: commit and push.",
          },
        ],
      });
      notify({
        type: "question",
        id: "run-2",
        name: "planner",
        requestId: "request-1",
        message: "May I delete the branch?",
        generation: 1,
      });
      const [completion, question] = sentMessages(sendMessage);
      const agentMessage = custom("pi-subagents-agent-message", "Message from run-3:\nHi", {
        from: "run-3",
        to: "main",
        messageId: "message-1",
      });
      const stored = [typed, completion, question, agentMessage, custom("other", "Untouched.")];

      const sent = yield* Effect.promise(() =>
        host.modelContext(extensionContextFixture(), Arr.filter(stored, Predicate.isNotUndefined)),
      );

      expect(sent[0]).toEqual(typed);
      expect(sent[4]).toEqual(custom("other", "Untouched."));
      expect(contentOf(sent[1])).toContain("subagent run-1");
      expect(contentOf(sent[1])).toContain("Next step: commit and push.");
      expect(contentOf(sent[2])).toContain("question from subagent run-2");
      expect(contentOf(sent[3])).toContain("agent run-3");
      for (const message of sent.slice(1, 4)) {
        expect(contentOf(message)).toContain("<pi_extension_message");
        expect(contentOf(message)).toContain("not typed by the user");
      }
    }),
  );

  it.effect("a child marks descendant updates, peer notices, and reminders", () =>
    Effect.gen(function* () {
      const host = recordingExtensionHost({}, { events: createEventBus() });
      registerSubagentChildBridge(host.pi, {
        loadSettings: () => Promise.resolve(),
        openIpc: () => ({ sendContact: () => Effect.void, listen: () => () => {} }),
      });
      const stored = [
        custom("pi-subagents-proxy-notification", "Background subagent completed."),
        custom("pi-subagents-peer-notice", "You share this working directory."),
        custom("pi-subagents-final-report-reminder", "Reply now with your final report."),
        typed,
      ];

      const sent = yield* Effect.promise(() =>
        host.modelContext(extensionContextFixture(), stored),
      );

      expect(sent[3]).toEqual(typed);
      for (const message of sent.slice(0, 3)) {
        expect(contentOf(message)).toContain('source="pi-subagents"');
        expect(contentOf(message)).toContain("not typed by the user");
      }
    }),
  );
});
