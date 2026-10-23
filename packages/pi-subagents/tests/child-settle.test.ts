import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import {
  fauxModels,
  quietLoader,
  quietSettings,
  scopedPrintSession,
} from "pi-cosmic-core/testing/sdk";
import {
  FINAL_REPORT_REMINDER_MESSAGE_TYPE,
  PROXY_NOTIFICATION_MESSAGE_TYPE,
  registerChildSettle,
} from "../src/boundary/host-child-settle.ts";
import * as Arr from "effect/Array";

interface ChildSessionSlot {
  session?: AgentSession;
  deliver?: (message: string) => boolean;
}

const transcriptText = (context: TranscriptContext): string => JSON.stringify(context.messages);

const childSession = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-child-settle-");
  const { fake, models } = yield* fauxModels("child-settle-test");
  const settings = quietSettings();
  const slot: ChildSessionSlot = {};
  const loader = yield* quietLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      (pi) => {
        slot.deliver = registerChildSettle(pi, () => slot.session?.isIdle ?? false);
      },
    ],
  });
  const session = yield* scopedPrintSession({
    cwd: directory,
    agentDir: directory,
    model: fake.getModel(),
    modelRuntime: models,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(directory),
    resourceLoader: loader,
  });
  slot.session = session;
  const customMessages = (customType: string) =>
    Arr.filter(
      session.messages,
      (message) => message.role === "custom" && message.customType === customType,
    );
  return {
    session,
    fake,
    deliver: (message: string) => slot.deliver?.(message) ?? false,
    customMessages,
  };
});

describe("nested Pi child settle policy", () => {
  it.live("keeps a descendant report through a queue clear and reacts before settling", () =>
    Effect.gen(function* () {
      const child = yield* childSession;
      const seen: string[] = [];
      child.fake.setResponses([
        () => {
          child.deliver("Descendant reader (agent-2) reported: tokenizer is safe.");
          // An interrupt clears Pi's steering queues before it aborts.
          child.session.clearQueue();
          return fauxAssistantMessage("Still reviewing.");
        },
        (context) => {
          seen.push(transcriptText(context));
          return fauxAssistantMessage("Final report: tokenizer and parser are safe.");
        },
      ]);

      yield* Effect.promise(() => child.session.prompt("Review the parser."));

      expect(child.customMessages(PROXY_NOTIFICATION_MESSAGE_TYPE)).toHaveLength(1);
      expect(seen[0]).toContain("tokenizer is safe");
      expect(child.fake.getPendingResponseCount()).toBe(0);
    }),
  );

  it.live("asks once for a final report after an empty final message", () =>
    Effect.gen(function* () {
      const child = yield* childSession;
      child.fake.setResponses([
        fauxAssistantMessage(""),
        fauxAssistantMessage("Final report: the parser is safe."),
        fauxAssistantMessage(""),
        fauxAssistantMessage(""),
      ]);

      yield* Effect.promise(() => child.session.prompt("Review the parser."));
      expect(child.customMessages(FINAL_REPORT_REMINDER_MESSAGE_TYPE)).toHaveLength(1);
      expect(child.session.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Final report: the parser is safe." }],
      });

      yield* Effect.promise(() => child.session.prompt("Review the lexer."));
      expect(child.customMessages(FINAL_REPORT_REMINDER_MESSAGE_TYPE)).toHaveLength(2);
      expect(child.fake.getPendingResponseCount()).toBe(0);
    }),
  );
});
