import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { makePiManagedRuntime } from "pi-cosmic-core";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { renderContextFixture } from "pi-code-previews/testing";
import { expect } from "vitest";
import { MAIN_AGENT_ID } from "../../src/run/agent-messaging.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/run/tool-policy.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { decodeStartAwaitCardDetails } from "../../src/tools/details-decode.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { fakeAgentMain } from "../run/fixtures/agent-main.ts";
import {
  awaitObservations,
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  runView,
} from "../run/fixtures/service-harness.ts";
import { stringContaining } from "../support/matchers.ts";
import { step } from "../support/effect-test.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./fixtures/tool-harness.ts";

const rootTools = Effect.gen(function* () {
  const main = fakeAgentMain({ state: "busy" });
  const fixture = nativeReportServiceFixture(fakeNativeReportBackendLayer(), {
    agentMain: main.capabilities,
  });
  const { pi, tools } = recordingExtensionHost();
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => makePiManagedRuntime(pi, Layer.merge(fixture.layer, fixture.backend.layer))),
    (owned) => step(() => owned.dispose()),
  );
  const service = yield* step(() => runtime.run(SubagentService));
  registerSubagentTools(pi, {
    environment: { cwd: "/project", projectTrusted: true },
    run: (effect, signal) => runtime.run(effect, signal),
  });
  const start = (name: string) =>
    step(() => runtime.run(service.startSessionOwned(nativeReportRequest({ name }))));
  const send = (from: SubagentRunView, text: string) =>
    step(() =>
      runtime.run(service.agentSend({ kind: "run", runId: from.id }, MAIN_AGENT_ID, text)),
    );
  // Resolves once a progress update satisfies `ready`, so the wait is observing.
  const awaitTool = (
    runIds: ReadonlyArray<string>,
    ready: (result: AgentToolResult<unknown>) => boolean = () => true,
  ) => {
    const observing = Deferred.makeUnsafe<void>();
    const pending = executeTool(
      tools.get("agent_await")!,
      { runIds: [...runIds], until: "all_finished" },
      {
        update: (result) => {
          if (ready(result)) Deferred.doneUnsafe(observing, Effect.void);
        },
      },
    );
    return { observing: Deferred.await(observing), result: step(() => pending) };
  };
  return { fixture, main, runtime, service, start, send, awaitTool };
});

const showsCompleted = (id: string) => (result: AgentToolResult<unknown>) => {
  const details = decodeStartAwaitCardDetails(result.details);
  return (
    details?.action === "await" &&
    Arr.some(details.cards, (card) => card.id === id && card.state === "completed")
  );
};

it.live("returns for a message to main without consuming reports, and awaits again", () =>
  Effect.gen(function* () {
    const { fixture, main, runtime, service, start, send, awaitTool } = yield* rootTools;
    const worker = yield* start("worker");
    const peer = yield* start("peer");

    const first = awaitTool([worker.id]);
    yield* first.observing;
    yield* send(peer, "The schema moved to db/schema.ts.");
    const ended = yield* first.result;
    expect(ended.structuredContent).toMatchObject({
      outcome: "message",
      messagesFrom: [{ id: peer.id, name: "peer" }],
      targets: [{ runId: worker.id, state: "running" }],
    });
    expect(ended.details).toMatchObject({
      agentMessages: { count: 1, senders: [{ id: peer.id, name: "peer" }], endedWait: true },
    });
    expect(ended.content[0]).toMatchObject({ text: stringContaining(peer.id) });
    expect(main.delivered).toHaveLength(1);
    expect((yield* step(() => runtime.run(runView(service, worker.id)))).state).toBe("running");

    const second = awaitTool([worker.id]);
    yield* second.observing;
    fixture.backend.controls[0]!.report(worker.id, 1, "worker-report", "Worker report.");
    const finished = yield* second.result;
    expect(finished.structuredContent).toMatchObject({
      outcome: "finished",
      targets: [{ runId: worker.id, report: { status: "delivered" } }],
    });
    expect(finished.structuredContent).not.toHaveProperty("messagesFrom");
  }),
);

it.live("delivers a finished report once beside the message that ended the wait", () =>
  Effect.gen(function* () {
    const { fixture, runtime, service, start, send, awaitTool } = yield* rootTools;
    const done = yield* start("done");
    const busy = yield* start("busy");
    const peer = yield* start("peer");

    const waiting = awaitTool([done.id, busy.id], showsCompleted(done.id));
    fixture.backend.controls[0]!.report(done.id, 1, "done-report", "Done report.");
    yield* waiting.observing;
    yield* send(peer, "Busy needs the new API key.");
    const result = yield* waiting.result;
    expect(result.structuredContent).toMatchObject({
      outcome: "message",
      messagesFrom: [{ id: peer.id }],
      targets: [
        { runId: done.id, state: "completed", report: { status: "delivered" } },
        { runId: busy.id, state: "running" },
      ],
    });
    expect(result.content[0]).toMatchObject({ text: stringContaining("Done report.") });

    // Delivered by this result only: no notice repeats it, and a later await finds it delivered.
    yield* Effect.sleep(Duration.millis(150));
    expect(Arr.filter(fixture.notifications, (item) => item.type === "completed")).toEqual([]);
    const [observed] = yield* step(() => runtime.run(awaitObservations(service, [done.id])));
    expect(observed).toMatchObject({ run: { reportStatus: "delivered" } });
    expect(observed?.completionReceipt).toBeUndefined();
  }),
);

it.live("summarizes a question that arrived beside a message as the reason the wait ended", () =>
  Effect.gen(function* () {
    const target = view({ id: "agent-1", name: "worker", state: "running" });
    const asking = view({
      id: "agent-2",
      name: "asker",
      state: "waiting_for_parent",
      question: { requestId: "q-1", message: "Which API?" },
    });
    const messages = {
      count: 1,
      arrivals: [{ from: "agent-3", fromName: "peer", text: "Heads up.", truncated: false }],
    };
    const awaitWith = (questions: ReadonlyArray<SubagentRunView>) =>
      Effect.gen(function* () {
        const tool = captureSubagentTools(
          subagentServiceDouble({
            withAwaitTerminalObservations: (_ids, _until, _onUpdate, use) =>
              use([{ run: target }], questions, messages),
          }),
        ).get("agent_await")!;
        const args = { runIds: [target.id], until: "all_finished" };
        const result = yield* step(() => executeTool(tool, args));
        const summary = createSubagentCompactSummary(SUBAGENT_TOOL_NAME.await)({
          phase: "settled",
          args,
          result: { content: [...result.content], details: result.details },
          context: renderContextFixture({}),
        });
        const note = Arr.findFirst(
          summary?.issues ?? [],
          (issue) => issue.code === "await-agent-message",
        ).pipe(Option.getOrUndefined);
        return { result, summary, note };
      });

    const messageOnly = yield* awaitWith([]);
    expect(messageOnly.result.structuredContent).toMatchObject({ outcome: "message" });
    expect(messageOnly.summary?.outcome).toBe("returned");

    const withQuestion = yield* awaitWith([asking]);
    expect(withQuestion.result.structuredContent).toMatchObject({ outcome: "attention" });
    expect(withQuestion.summary?.outcome).toBe("warning");
    expect(withQuestion.note).toBeDefined();
    expect(withQuestion.note?.message).not.toBe(messageOnly.note?.message);
  }),
);
