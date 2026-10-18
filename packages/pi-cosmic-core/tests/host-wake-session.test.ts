import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type ExtensionFactory,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { registerSessionWake } from "../src/host-wake.ts";
import { temporaryDirectory } from "../src/testing/ipc-child.ts";
import {
  fauxModels,
  quietLoader,
  quietSettings,
  scopedPrintSession,
} from "../src/testing/sdk-session.ts";

type Sender = "first" | "second";

interface SessionSlot {
  session?: AgentSession;
}

const noticeText = (sender: Sender) => `Notice from the ${sender} extension.`;

/** Two extensions in one session, each owning its own wake and notice type. */
const twoWakeSession = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-session-wake-");
  const { fake, models } = yield* fauxModels("session-wake-test");
  const settings = quietSettings();
  const bound: SessionSlot = {};
  const senders = new Map<Sender, () => void>();
  const extension =
    (sender: Sender): ExtensionFactory =>
    (pi) => {
      const customType = `${sender}-notice`;
      const wake = registerSessionWake(pi, {
        noticeTypes: new Set([customType]),
        wakeMessage: { customType: `${sender}-wake`, content: "Act on the notices above." },
        isIdle: () => bound.session?.isIdle ?? false,
        later: (check) => setImmediate(check),
      });
      senders.set(sender, () =>
        wake.deliver((startTurn) => {
          pi.sendMessage(
            { customType, content: noticeText(sender), display: true },
            { triggerTurn: startTurn },
          );
          return true;
        }),
      );
    };
  const loader = yield* quietLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [extension("first"), extension("second")],
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
  bound.session = session;
  const send = (sender: Sender) => senders.get(sender)?.();
  return { session, fake, send };
});

const transcriptText = (context: TranscriptContext): string => JSON.stringify(context.messages);

describe("session wake with two extensions in a real Pi session", () => {
  for (const sending of [["first", "second"], ["first"], ["second"]] as const) {
    it.live(`continues the run for notices from ${sending.join(" and ")}`, () =>
      Effect.gen(function* () {
        const test = yield* twoWakeSession;
        const noticesArriveMidTurn: FauxResponseFactory = () => {
          for (const sender of sending) test.send(sender);
          return fauxAssistantMessage("Working on it.");
        };
        const seen: Array<string> = [];
        test.fake.setResponses([
          noticesArriveMidTurn,
          (context) => {
            seen.push(transcriptText(context));
            return fauxAssistantMessage("Handled the notices.");
          },
          fauxAssistantMessage("This continuation must not run."),
        ]);

        yield* Effect.promise(() => test.session.prompt("Start the task."));
        yield* Effect.promise(() => test.session.waitForIdle());

        expect(test.fake.getPendingResponseCount()).toBe(1);
        for (const sender of sending) expect(seen[0]).toContain(noticeText(sender));
        expect(test.session.messages.at(-1)).toMatchObject({ role: "assistant" });
      }),
    );
  }
});
