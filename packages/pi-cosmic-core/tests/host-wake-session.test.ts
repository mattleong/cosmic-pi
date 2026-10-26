import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { registerSessionWake, type SessionWakeDelivery } from "../src/host-wake.ts";
import { temporaryDirectory } from "../src/testing/ipc-child.ts";
import {
  fauxModels,
  QUIET_RESOURCES,
  quietLoader,
  quietSettings,
  scopedPrintSession,
} from "../src/testing/sdk-session.ts";
import { eventLoopTurn, macrotask, step } from "../src/testing/steps.ts";

type Sender = "first" | "second";

interface SessionSlot {
  session?: AgentSession;
}

type Senders = Map<Sender, () => SessionWakeDelivery>;

const noticeText = (sender: Sender) => `Notice from the ${sender} extension.`;

/** An extension owning its own wake and notice type; `senders` delivers one of its notices. */
const wakeOwner =
  (sender: Sender, bound: SessionSlot, senders: Senders): ExtensionFactory =>
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

const deliverFrom = (senders: Senders, sender: Sender): SessionWakeDelivery => {
  const send = senders.get(sender);
  if (!send) throw new Error(`The ${sender} extension is not loaded.`);
  return send();
};

interface WakeSessionExtensions {
  /** Loaded before the wake owners, so their handlers for an event run first. */
  readonly before?: (send: (sender: Sender) => SessionWakeDelivery) => ExtensionFactory;
  /** Loaded after the wake owners. */
  readonly after?: (send: (sender: Sender) => SessionWakeDelivery) => ExtensionFactory;
}

/** Two extensions in one print-mode session, each owning its own wake and notice type. */
const twoWakeSession = Effect.fn("twoWakeSession")(function* (
  extensions: WakeSessionExtensions = {},
) {
  const directory = yield* temporaryDirectory("pi-session-wake-");
  const { fake, models } = yield* fauxModels("session-wake-test");
  const settings = quietSettings();
  const bound: SessionSlot = {};
  const senders: Senders = new Map();
  const send = (sender: Sender) => deliverFrom(senders, sender);
  const loader = yield* quietLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      ...(extensions.before ? [extensions.before(send)] : []),
      wakeOwner("first", bound, senders),
      wakeOwner("second", bound, senders),
      ...(extensions.after ? [extensions.after(send)] : []),
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
  bound.session = session;
  return { session, fake, send };
});

const transcriptText = (context: TranscriptContext): string => JSON.stringify(context.messages);

const settleTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 5; turn += 1) yield* macrotask;
});

describe("session wake with two extensions in a real Pi session", () => {
  for (const sending of [["first", "second"], ["first"], ["second"]] as const) {
    it.live(`continues the run for notices from ${Arr.join(sending, " and ")}`, () =>
      Effect.gen(function* () {
        const test = yield* twoWakeSession();
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

  it.live("starts one turn for notices both extensions are owed as the run settles", () =>
    Effect.gen(function* () {
      const dispositions: Array<SessionWakeDelivery> = [];
      let delivered = false;
      // Both notices arrive after both owners' settle boundaries, so each is owed a wake.
      const test = yield* twoWakeSession({
        after: (send) => (pi) => {
          pi.on("agent_before_settle", () => {
            if (delivered) return undefined;
            delivered = true;
            dispositions.push(send("first"), send("second"));
            return undefined;
          });
        },
      });
      const seen: Array<string> = [];
      test.fake.setResponses([
        fauxAssistantMessage("Done."),
        (context) => {
          seen.push(transcriptText(context));
          return fauxAssistantMessage("Handled the notices.");
        },
        fauxAssistantMessage("This second wake must not run."),
      ]);

      // Print mode returns once the prompt does, so the wake has to run within it.
      yield* Effect.promise(() => test.session.prompt("Start the task."));
      expect(test.fake.getPendingResponseCount()).toBe(1);
      yield* settleTurns;
      yield* Effect.promise(() => test.session.waitForIdle());

      expect(dispositions).toEqual(["queued", "queued"]);
      expect(test.fake.getPendingResponseCount()).toBe(1);
      expect(seen[0]).toContain(noticeText("first"));
      expect(seen[0]).toContain(noticeText("second"));
    }),
  );

  it.live("starts one turn for notices both extensions get while a later extension settles", () =>
    Effect.gen(function* () {
      const dispositions: Array<SessionWakeDelivery> = [];
      let delivered = false;
      // Both owners' agent_settled handlers have run; Pi defers any turn started now.
      const test = yield* twoWakeSession({
        after: (send) => (pi) => {
          pi.on("agent_settled", () => {
            if (delivered) return undefined;
            delivered = true;
            return eventLoopTurn().then(() => {
              dispositions.push(send("first"), send("second"));
              return undefined;
            });
          });
        },
      });
      const seen: Array<string> = [];
      test.fake.setResponses([
        fauxAssistantMessage("Done."),
        (context) => {
          seen.push(transcriptText(context));
          return fauxAssistantMessage("Handled the notices.");
        },
        fauxAssistantMessage("This second turn must not run."),
      ]);

      yield* Effect.promise(() => test.session.prompt("Start the task."));
      yield* settleTurns;
      yield* Effect.promise(() => test.session.waitForIdle());

      expect(dispositions).toEqual(["woken", "queued"]);
      expect(test.fake.getPendingResponseCount()).toBe(1);
      expect(seen[0]).toContain(noticeText("first"));
      expect(seen[0]).toContain(noticeText("second"));
    }),
  );

  it.live("holds a notice that arrives while an earlier extension settles an interrupt", () =>
    Effect.gen(function* () {
      const dispositions: Array<SessionWakeDelivery> = [];
      // Pi marks the session idle before it awaits each extension's agent_settled handler.
      const test = yield* twoWakeSession({
        before: (send) => (pi) => {
          pi.on("agent_settled", (event) =>
            event.aborted
              ? eventLoopTurn().then(() => {
                  dispositions.push(send("first"));
                  return undefined;
                })
              : undefined,
          );
        },
      });
      test.fake.setResponses([
        () => {
          test.session.abort().catch(() => undefined);
          return fauxAssistantMessage("Interrupted.");
        },
        fauxAssistantMessage("This turn must not run before the user's next prompt."),
      ]);

      yield* Effect.promise(() => test.session.prompt("Start the task.").catch(() => undefined));
      yield* settleTurns;
      yield* Effect.promise(() => test.session.waitForIdle());

      expect(dispositions).toHaveLength(1);
      expect(dispositions[0]).not.toBe("woken");
      expect(test.fake.getPendingResponseCount()).toBe(1);
      expect(
        Arr.some(
          test.session.messages,
          (message) => message.role === "custom" && message.content === noticeText("first"),
        ),
      ).toBe(true);
    }),
  );
});

describe("session wake while Pi replaces the session", () => {
  it.live("holds a notice that arrives during an earlier extension's shutdown", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-session-wake-replace-");
      const { fake, models } = yield* fauxModels("session-wake-replace-test");
      const settings = quietSettings();
      const bound: SessionSlot = {};
      const senders: Senders = new Map();
      const dispositions: Array<SessionWakeDelivery> = [];
      let shutdowns = 0;
      // Pi emits session_shutdown in load order once the replaced run is aborted.
      const slowShutdown: ExtensionFactory = (pi) => {
        pi.on("session_shutdown", () => {
          shutdowns += 1;
          if (shutdowns > 1) return undefined;
          return eventLoopTurn()
            .then(() => {
              dispositions.push(deliverFrom(senders, "first"));
              return undefined;
            })
            .then(eventLoopTurn);
        });
      };
      const createRuntime: CreateAgentSessionRuntimeFactory = (options) =>
        createAgentSessionServices({
          cwd: options.cwd,
          agentDir: options.agentDir,
          modelRuntime: models,
          settingsManager: settings,
          resourceLoaderOptions: {
            ...QUIET_RESOURCES,
            noExtensions: true,
            extensionFactories: [slowShutdown, wakeOwner("first", bound, senders)],
          },
        }).then((services) =>
          createAgentSessionFromServices({
            services,
            sessionManager: options.sessionManager,
            ...(options.sessionStartEvent && { sessionStartEvent: options.sessionStartEvent }),
            model: fake.getModel(),
          }).then((created) => ({ ...created, services, diagnostics: services.diagnostics })),
        );
      const runtime = yield* Effect.acquireRelease(
        step(() =>
          createAgentSessionRuntime(createRuntime, {
            cwd: directory,
            agentDir: directory,
            sessionManager: SessionManager.inMemory(directory),
          }),
        ),
        (created) => step(() => created.dispose()),
      );
      yield* step(() => runtime.session.bindExtensions({ mode: "print" }));
      bound.session = runtime.session;
      fake.setResponses([
        fauxAssistantMessage("Done."),
        fauxAssistantMessage("The closing session must not start this turn."),
      ]);
      yield* step(() => runtime.session.prompt("Start the task."));

      yield* step(() => runtime.newSession());
      yield* settleTurns;

      expect(dispositions).toEqual(["closing"]);
      expect(fake.getPendingResponseCount()).toBe(1);
    }),
  );
});
