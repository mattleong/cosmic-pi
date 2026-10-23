import {
  fauxAssistantMessage,
  type FauxResponseFactory,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
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
import { hostNotifier, type SubagentNotifier } from "../src/boundary/host-notifier.ts";
import { registerParentWake } from "../src/boundary/host-parent-wake.ts";
import { projectionOf } from "./fixtures/run-view.ts";
import * as Arr from "effect/Array";

const REPORT = "Report: the parser handles nested quotes.";

interface ParentSessionSlot {
  session?: AgentSession;
}

const transcriptText = (context: TranscriptContext): string => JSON.stringify(context.messages);

const parentSession = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-parent-wake-");
  const { fake, models } = yield* fauxModels("parent-wake-test");
  const settings = quietSettings();
  const bound: ParentSessionSlot = {};
  let notify: SubagentNotifier | undefined;
  const loader = yield* quietLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    extensionFactories: [
      (pi) => {
        const wake = registerParentWake(pi, {
          projection: () => projectionOf([]),
          drain: () => undefined,
          isIdle: () => bound.session?.isIdle ?? false,
          later: (check) => setImmediate(check),
        });
        notify = hostNotifier(pi, { delivery: wake });
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
  bound.session = session;
  const parent = session;
  const deliverReport = () =>
    notify?.({
      type: "completed",
      runs: [
        { id: "agent-1", name: "reader", generation: 1, outcome: "completed", finalText: REPORT },
      ],
    });
  const reportsInTranscript = () =>
    Arr.filter(
      parent.messages,
      (message) => message.role === "custom" && message.customType === "pi-subagents-completed",
    ).length;
  return { session: parent, fake, deliverReport, reportsInTranscript };
});

describe("parent wake with a real Pi session", () => {
  it.live("keeps a report that arrives during a turn when the queue is cleared, then wakes", () =>
    Effect.gen(function* () {
      const parent = yield* parentSession;
      const reportArrivesMidTurn: FauxResponseFactory = () => {
        parent.deliverReport();
        // Dequeue and Esc restore clear Pi's steering queues while the turn streams.
        parent.session.clearQueue();
        return fauxAssistantMessage("Waiting for the reader.");
      };
      const seen: string[] = [];
      parent.fake.setResponses([
        reportArrivesMidTurn,
        (context) => {
          seen.push(transcriptText(context));
          return fauxAssistantMessage("Reviewed the reader's report.");
        },
      ]);

      yield* Effect.promise(() => parent.session.prompt("Delegate the parser review."));

      expect(parent.reportsInTranscript()).toBe(1);
      expect(parent.fake.getPendingResponseCount()).toBe(0);
      expect(seen[0]).toContain("the parser handles nested quotes");
      expect(parent.session.messages.at(-1)).toMatchObject({ role: "assistant" });
    }),
  );

  it.live("keeps a report in the transcript when the user interrupts the turn", () =>
    Effect.gen(function* () {
      const parent = yield* parentSession;
      parent.fake.setResponses([
        () => {
          parent.deliverReport();
          parent.session.clearQueue();
          parent.session.abort().catch(() => undefined);
          return fauxAssistantMessage("Interrupted.", { stopReason: "aborted" });
        },
        fauxAssistantMessage("This wake must not run."),
      ]);

      yield* Effect.promise(() => parent.session.prompt("Delegate the parser review."));
      yield* Effect.promise(() => parent.session.waitForIdle());

      expect(parent.reportsInTranscript()).toBe(1);
      expect(parent.fake.getPendingResponseCount()).toBe(1);
    }),
  );

  it.live("starts a turn for a report that arrives while the parent is idle", () =>
    Effect.gen(function* () {
      const parent = yield* parentSession;
      parent.fake.setResponses([fauxAssistantMessage("Reviewed the reader's report.")]);

      parent.deliverReport();
      yield* Effect.promise(() => parent.session.waitForIdle());

      expect(parent.reportsInTranscript()).toBe(1);
      expect(parent.fake.getPendingResponseCount()).toBe(0);
    }),
  );
});
