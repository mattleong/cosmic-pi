import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
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

type ExtensionFactory = (pi: ExtensionAPI) => void;

// Other extensions load before and after this one, as in a child with installed packages.
const childSession = (
  others: {
    readonly before?: ExtensionFactory;
    readonly after?: (pi: ExtensionAPI, deliver: (message: string) => boolean) => void;
  } = {},
) =>
  Effect.gen(function* () {
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
        (pi) => others.before?.(pi),
        (pi) => {
          slot.deliver = registerChildSettle(pi, () => slot.session?.isIdle ?? false);
        },
        (pi) => others.after?.(pi, (message) => slot.deliver?.(message) ?? false),
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
      const child = yield* childSession();
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

  it.live("refuses a notice once the run settles, even while Pi defers another run", () =>
    Effect.gen(function* () {
      const deliveries: boolean[] = [];
      let woke = false;
      const child = yield* childSession({
        // Another extension's wake runs first, ahead of anything the notice could start.
        before: (pi) =>
          pi.on("agent_settled", () => {
            if (woke) return;
            woke = true;
            pi.sendMessage(
              { customType: "other-wake", content: "A task exited.", display: false },
              { triggerTurn: true },
            );
          }),
        after: (pi, deliver) =>
          pi.on("agent_settled", () => {
            if (deliveries.length === 0) deliveries.push(deliver("Descendant reported."));
          }),
      });
      child.fake.setResponses([
        fauxAssistantMessage("Run 1 report."),
        fauxAssistantMessage("Run 2: reacted to the task exit."),
      ]);
      yield* Effect.promise(() => child.session.prompt("Review the parser."));
      yield* Effect.promise(() => child.session.waitForIdle());
      // Idle, and the run the extension started wasn't opened by the parent.
      deliveries.push(child.deliver("Descendant reported again."));

      expect(deliveries).toEqual([false, false]);
      expect(child.customMessages(PROXY_NOTIFICATION_MESSAGE_TYPE)).toHaveLength(0);
      expect(child.fake.getPendingResponseCount()).toBe(0);
    }),
  );

  it.live("refuses a notice after its settle check and takes one once a continuation reopens", () =>
    Effect.gen(function* () {
      const deliveries: boolean[] = [];
      const child = yield* childSession({
        after: (pi, deliver) =>
          pi.on("agent_before_settle", () => {
            if (deliveries.length === 0) deliveries.push(deliver("Descendant writer reported."));
          }),
      });
      const seen: string[] = [];
      child.fake.setResponses([
        // An empty report gets the reminder, so the run continues.
        fauxAssistantMessage(""),
        () => {
          deliveries.push(child.deliver("Descendant reader reported: tokenizer is safe."));
          return fauxAssistantMessage("Final report: the parser is safe.");
        },
        (context) => {
          seen.push(transcriptText(context));
          return fauxAssistantMessage("Final report: the parser and tokenizer are safe.");
        },
      ]);
      yield* Effect.promise(() => child.session.prompt("Review the parser."));

      expect(deliveries).toEqual([false, true]);
      expect(child.customMessages(PROXY_NOTIFICATION_MESSAGE_TYPE)).toHaveLength(1);
      expect(seen[0]).toContain("tokenizer is safe");
      expect(child.fake.getPendingResponseCount()).toBe(0);
    }),
  );

  it.live("asks once for a final report after an empty final message", () =>
    Effect.gen(function* () {
      const child = yield* childSession();
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
