import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { type AgentCaller, MAIN_AGENT_ID } from "../../src/run/agent-messaging.ts";
import {
  PENDING_STEER_DELIVERY_CODE,
  SubagentNotFoundError,
  SubagentProcessError,
} from "../../src/run/errors.ts";
import {
  captureSubagentControlExpectation,
  type SubagentProjection,
  type SubagentRunView,
} from "../../src/run/model.ts";
import { anyString, objectContaining, stringContaining } from "../support/matchers.ts";
import { fakeAgentMain } from "./fixtures/agent-main.ts";
import {
  acknowledgeCompletions,
  assistantMessageEndFrame,
  completeLocalRun,
  contactParentFrame,
  type FakeChildControl,
  fakeChildLayer,
  fakeNativeReportBackendLayer,
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";

const MAIN: AgentCaller = { kind: "main" };
const asRun = (run: SubagentRunView): AgentCaller => ({ kind: "run", runId: run.id });
const nesting = { maxDirectChildren: 12, maxDepth: 3 };

const steerMessages = (control: FakeChildControl | undefined): ReadonlyArray<string> =>
  (control?.commands ?? []).flatMap((command) =>
    command.type === "prompt" && command.streamingBehavior === "steer" ? [command.message] : [],
  );

const promptMessages = (control: FakeChildControl | undefined): ReadonlyArray<string> =>
  (control?.commands ?? []).flatMap((command) =>
    command.type === "prompt" && command.streamingBehavior === undefined ? [command.message] : [],
  );

const latest = (projections: ReadonlyArray<SubagentProjection>, id: string) =>
  projections.at(-1)?.runs.find((run) => run.id === id);

const messageNotices = (run: SubagentRunView | undefined) =>
  (run?.sessionEvents ?? []).flatMap((event) =>
    event.type === "notice" && event.kind === "message"
      ? [{ direction: event.direction, peer: event.peer, text: event.text }]
      : [],
  );

const parentNotices = (run: SubagentRunView | undefined) =>
  (run?.sessionEvents ?? []).flatMap((event) =>
    event.type === "notice" && event.kind === "parent" ? [event.text] : [],
  );

const askQuestion = (
  control: FakeChildControl,
  projections: ReadonlyArray<SubagentProjection>,
  id: string,
  requestId: string,
) =>
  Effect.gen(function* () {
    control.offerIpc(contactParentFrame(requestId, "question", "Which API?"));
    yield* yieldUntil(() => latest(projections, id)?.state === "waiting_for_parent");
  });

describe("agent messaging", () => {
  it.effect("reaches agents outside the caller's subtree under the caller's own identity", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const alpha = yield* service.start(request({ name: "alpha", nestingPolicy: nesting }));
      const beta = yield* service.start(request({ name: "beta", nestingPolicy: nesting }));
      const child = yield* service.startSessionOwnedFrom(
        alpha.id,
        request({ name: "alpha-child", nestingPolicy: nesting }),
      );

      const toSibling = yield* service.agentSend(asRun(alpha), beta.id, "Check the schema.");
      expect(toSibling).toMatchObject({ to: beta.id, disposition: "guided" });
      expect(steerMessages(fake.controls[1])).toEqual([stringContaining(alpha.id)]);
      expect(steerMessages(fake.controls[1])[0]).toContain("Check the schema.");

      expect((yield* service.agentSend(asRun(beta), child.id, "Use the cache.")).disposition).toBe(
        "guided",
      );
      expect(steerMessages(fake.controls[2])[0]).toContain(beta.id);

      expect(messageNotices(latest(projections, alpha.id))).toEqual([
        { direction: "out", peer: beta.id, text: "Check the schema." },
      ]);
      expect(messageNotices(latest(projections, beta.id))).toEqual([
        { direction: "in", peer: alpha.id, text: "Check the schema." },
        { direction: "out", peer: child.id, text: "Use the cache." },
      ]);
      expect(latest(projections, alpha.id)?.messageCount).toBe(1);
      expect(latest(projections, beta.id)?.messageCount).toBe(2);
      expect(latest(projections, child.id)?.messageCount).toBe(1);

      const forged = yield* service
        .agentSend({ kind: "run", runId: "agent-forged-1" }, beta.id, "Pretend to be main.")
        .pipe(Effect.flip);
      expect(forged).toBeInstanceOf(SubagentNotFoundError);
      expect(steerMessages(fake.controls[1])).toHaveLength(1);

      const listing = yield* service.agentList(asRun(child));
      expect(listing.agents.map((agent) => agent.id)).toEqual(
        expect.arrayContaining([MAIN_AGENT_ID, alpha.id, beta.id, child.id]),
      );
      expect(listing.agents.find((agent) => agent.self)?.id).toBe(child.id);
    });
  });

  it.effect("lets any ancestor answer a waiting run; other agents guide it", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent", nestingPolicy: nesting }));
      const sibling = yield* service.start(request({ name: "sibling", nestingPolicy: nesting }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "child", nestingPolicy: nesting }),
      );
      const childControl = fake.controls[2]!;
      yield* askQuestion(childControl, projections, child.id, "question-1");

      // The sibling's guidance waits behind the question until an ancestor answers it.
      const fromSibling = yield* service.agentSend(asRun(sibling), child.id, "Prefer v1.");
      expect(fromSibling).toMatchObject({ disposition: "guided", confirmed: true, parked: true });
      expect(childControl.sentIpc("parent_reply")).toBe(false);
      expect(latest(projections, child.id)?.state).toBe("waiting_for_parent");

      const fromParent = yield* service.agentSend(asRun(parent), child.id, "Use the public API.");
      expect(fromParent).toMatchObject({ disposition: "answered", run: { state: "running" } });
      expect(fromParent.parked).toBeUndefined();
      expect(
        childControl.sentIpc("parent_reply", (reply) => reply.message === "Use the public API."),
      ).toBe(true);
      expect(steerMessages(childControl)).toHaveLength(1);

      yield* askQuestion(childControl, projections, child.id, "question-2");
      expect(yield* service.agentSend(MAIN, child.id, "Use v2.")).toMatchObject({
        disposition: "answered",
        run: { state: "running" },
      });
      expect(childControl.sentIpc("parent_reply", (reply) => reply.message === "Use v2.")).toBe(
        true,
      );
    });
  });

  it.effect("lets the ancestor a question reached answer it once the parent finished", () => {
    const { fake, projections, notifications, layer } = localServiceFixture({
      notify: (notification) =>
        notification.type === "completed"
          ? acknowledgeCompletions(notification)
          : { actionAccepted: true },
    });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent", nestingPolicy: nesting }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "child", nestingPolicy: nesting }),
      );
      yield* completeLocalRun(service, fake.controls[0]!, parent.id, "Parent done.");
      const childControl = fake.controls[1]!;
      yield* askQuestion(childControl, projections, child.id, "question-routed");
      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => notifications.some((notice) => notice.type === "question"));
      expect(notifications.find((notice) => notice.type === "question")).toMatchObject({
        id: child.id,
      });

      expect(yield* service.agentSend(MAIN, child.id, "Use v2.")).toMatchObject({
        disposition: "answered",
        run: { state: "running" },
      });
      expect(childControl.sentIpc("parent_reply", (reply) => reply.message === "Use v2.")).toBe(
        true,
      );
    });
  });

  it.effect(
    "resumes a finished Pi run only for its ancestors, and it reports to its parent",
    () => {
      const { fake, projections, notifications, layer } = localServiceFixture({
        notify: acknowledgeCompletions,
      });
      return withService(layer, function* (service) {
        const worker = yield* service.start(request({ name: "worker" }));
        const peer = yield* service.start(request({ name: "peer" }));
        yield* completeLocalRun(service, fake.controls[0]!, worker.id, "First report.");
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 1);

        // A sibling is outside the worker's ancestry, so it can't give the worker a new assignment.
        expect(
          yield* service.agentSend(asRun(peer), worker.id, "Also cover retries.").pipe(Effect.flip),
        ).toMatchObject({ code: "agent_unavailable", message: stringContaining("ancestors") });
        expect(yield* runView(service, worker.id)).toMatchObject({
          state: "completed",
          assignmentEpoch: 1,
        });
        expect(fake.controls).toHaveLength(2);
        expect(messageNotices(latest(projections, peer.id))).toEqual([]);

        const resumed = yield* service.agentSend(MAIN, worker.id, "Also cover retries.");
        expect(resumed).toMatchObject({
          disposition: "resumed",
          run: { id: worker.id, state: "running", assignmentEpoch: 2 },
        });
        const resumedControl = fake.controls[2]!;
        expect(resumedControl.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
        expect(promptMessages(resumedControl)).toEqual([stringContaining("Also cover retries.")]);
        expect(messageNotices(latest(projections, worker.id))).toContainEqual({
          direction: "in",
          peer: MAIN_AGENT_ID,
          text: "Also cover retries.",
        });

        yield* completeLocalRun(service, resumedControl, worker.id, "Second report.");
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => notifications.length === 2);
        expect(notifications[1]?.type === "completed" && notifications[1].runs[0]).toMatchObject({
          id: worker.id,
          generation: 2,
          finalText: "Second report.",
        });
      });
    },
  );

  it.effect("refuses finished native runs and runs being removed from the session", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const native = yield* service.start(nativeReportRequest({ name: "native" }));
      expect((yield* service.agentSend(MAIN, native.id, "Keep going.")).disposition).toBe("guided");
      expect(backend.controls[0]?.prompts.at(-1)).toContain("Keep going.");
      backend.controls[0]?.report(native.id, 1, "native-report", "Native report.");
      yield* yieldUntil(() => latest(projections, native.id)?.state === "completed");
      expect(
        yield* service.agentSend(MAIN, native.id, "One more thing.").pipe(Effect.flip),
      ).toMatchObject({ code: "agent_resume_unsupported" });
      expect(
        yield* service.agentSend(MAIN, "agent-missing-1", "Hello.").pipe(Effect.flip),
      ).toMatchObject({ code: "agent_not_found" });
    });
  });

  it.effect("binds each native backend's agent messaging to its own run as the caller", () => {
    const { backend, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      const first = yield* service.start(nativeReportRequest({ name: "first" }));
      const second = yield* service.start(nativeReportRequest({ name: "second" }));
      const messaging = backend.agentMessaging[0]!;
      expect((yield* messaging.list()).agents.find((agent) => agent.self)?.id).toBe(first.id);
      expect((yield* messaging.send(second.id, "Compare notes.")).disposition).toBe("guided");
      expect(backend.controls[1]?.prompts.at(-1)).toContain(first.id);
      expect(yield* messaging.send(first.id, "Me?").pipe(Effect.flip)).toMatchObject({
        code: "agent_self_target",
      });
      expect((yield* messaging.read([second.id])).agents).toEqual([
        objectContaining({ id: second.id }),
      ]);
    });
  });

  it.effect("refuses a run whose state is being reclaimed, then reports it gone", () => {
    let gate: Deferred.Deferred<void> | undefined;
    const fake = fakeChildLayer(Effect.void, {
      get reclaimGate() {
        return gate;
      },
    });
    const { layer } = localServiceFixture({}, fake);
    return withService(layer, function* (service) {
      for (let index = 0; index < 50; index += 1) {
        const run = yield* service.start(request({ name: `history-${index + 1}` }));
        yield* completeLocalRun(service, fake.controls[index]!, run.id, `Report ${index + 1}`);
      }
      yield* TestClock.adjust("100 millis");
      gate = yield* Deferred.make<void>();
      const evicting = yield* service.start(request({ name: "evictor" })).pipe(Effect.forkScoped);
      yield* yieldUntil(() => fake.reclaimedRunIds.length === 1);
      const evicted = fake.reclaimedRunIds[0]!;
      expect(yield* service.agentSend(MAIN, evicted, "Resume?").pipe(Effect.flip)).toMatchObject({
        code: "agent_unavailable",
      });
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(evicting);
      expect(yield* service.agentSend(MAIN, evicted, "Resume?").pipe(Effect.flip)).toMatchObject({
        code: "agent_not_found",
      });
    });
  });

  it.effect("refuses messages to the sender itself", () => {
    const main = fakeAgentMain();
    const { layer } = localServiceFixture({ agentMain: main.capabilities });
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "self" }));
      for (const [caller, to] of [
        [MAIN, MAIN_AGENT_ID],
        [asRun(run), run.id],
      ] as const)
        expect(yield* service.agentSend(caller, to, "Hi.").pipe(Effect.flip)).toMatchObject({
          code: "agent_self_target",
        });
      expect(main.delivered).toEqual([]);
    });
  });

  it.effect(
    "wakes an idle main agent, queues for a busy one, and refuses a replaced session",
    () => {
      const main = fakeAgentMain();
      const { layer } = localServiceFixture({ agentMain: main.capabilities });
      return withService(layer, function* (service) {
        const run = yield* service.start(request({ name: "reporter" }));
        const send = (text: string) => service.agentSend(asRun(run), MAIN_AGENT_ID, text);
        for (const text of ["one", "two", "three", "four", "five"])
          expect(yield* send(text)).toMatchObject({ disposition: "guided", mainState: "idle" });
        expect(main.delivered.every((delivery) => delivery.startTurn)).toBe(true);
        expect(main.delivered[0]?.frame).toMatchObject({ from: run.id, to: MAIN_AGENT_ID });
        expect(main.delivered[0]?.frame.content).toContain("one");

        main.control.state = "busy";
        expect((yield* send("six")).mainState).toBe("busy");
        main.control.held = true;
        expect((yield* send("seven")).mainState).toBe("held");

        main.control.retired = true;
        expect(yield* send("eight").pipe(Effect.flip)).toMatchObject({ code: "agent_unavailable" });
      });
    },
  );

  it.effect(
    "resumes a finished child from its parent's messages as often as it is sent one",
    () => {
      const { fake, layer } = localServiceFixture();
      return withService(layer, function* (service) {
        const parent = yield* service.start(request({ name: "parent", nestingPolicy: nesting }));
        const child = yield* service.startSessionOwnedFrom(
          parent.id,
          request({ name: "child", nestingPolicy: nesting }),
        );
        yield* completeLocalRun(service, fake.controls[1]!, child.id);
        for (let round = 0; round < 5; round += 1) {
          expect((yield* service.agentSend(asRun(parent), child.id, "Again.")).disposition).toBe(
            "resumed",
          );
          yield* completeLocalRun(service, fake.controls.at(-1)!, child.id);
        }
      });
    },
  );

  it.effect("refuses resumes by agent messages once the session reached its spend limit", () => {
    const fake = fakeChildLayer();
    const { projections, layer } = localServiceFixture(
      {},
      fake,
      profileLayerFor({ version: 6, sessionSpendLimit: 1 }),
    );
    return withService(layer, function* (service) {
      const worker = yield* service.start(request({ name: "worker" }));
      fake.controls[0]!.offer({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Costly work." }],
          usage: { input: 10, totalTokens: 10, cost: { total: 1.5 } },
        },
      });
      fake.controls[0]!.offer({ type: "turn_end" });
      yield* yieldUntil(() => (projections.at(-1)?.sessionUsage?.cost ?? 0) >= 1.5, 200);
      yield* completeLocalRun(service, fake.controls[0]!, worker.id);

      expect(
        yield* service.agentSend(MAIN, worker.id, "One more pass.").pipe(Effect.flip),
      ).toMatchObject({ code: "agent_spend_limit" });
      expect(yield* runView(service, worker.id)).toMatchObject({
        state: "completed",
        assignmentEpoch: 1,
      });
      expect(fake.controls).toHaveLength(1);
    });
  });

  it.effect("never limits messages up, down, or across the tree", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent", nestingPolicy: nesting }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "child", nestingPolicy: nesting }),
      );
      const peer = yield* service.start(request({ name: "peer" }));
      for (let index = 0; index < 30; index += 1) {
        for (const [caller, to] of [
          [MAIN, child.id],
          [asRun(parent), child.id],
          [asRun(peer), child.id],
          [asRun(child), parent.id],
        ] as const)
          expect((yield* service.agentSend(caller, to, `Note ${index}.`)).disposition).toBe(
            "guided",
          );
      }
    });
  });

  it.effect("lets the main agent resume its own paused run any number of times", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "worker" }));
      for (let round = 0; round < 5; round += 1) {
        expect((yield* service.interrupt(run.id)).state).toBe("paused");
        expect((yield* service.agentSend(MAIN, run.id, "Continue.")).disposition).toBe("resumed");
      }
      expect((yield* runView(service, run.id)).state).toBe("running");
    });
  });

  it.effect("reads last messages without claiming reports before their parent delivery", () => {
    const main = fakeAgentMain({ state: "busy", text: "Main's latest reply." });
    const { fake, projections, notifications, layer } = localServiceFixture({
      agentMain: main.capabilities,
    });
    return withService(layer, function* (service) {
      const live = yield* service.start(request({ name: "live" }));
      const done = yield* service.start(request({ name: "done" }));
      fake.controls[0]!.offer(assistantMessageEndFrame("Halfway there."));
      yield* yieldUntil(
        () =>
          latest(projections, live.id)?.sessionEvents.some(
            (event) => event.type === "assistant",
          ) === true,
      );
      yield* completeLocalRun(service, fake.controls[1]!, done.id, "Done report.");

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const read = yield* service.agentRead(asRun(live), [MAIN_AGENT_ID, live.id, done.id]);
        expect(read.agents).toEqual([
          objectContaining({
            id: MAIN_AGENT_ID,
            state: "busy",
            text: "Main's latest reply.",
          }),
          objectContaining({ id: live.id, source: "assistant", text: "Halfway there." }),
          objectContaining({
            id: done.id,
            state: "completed",
            source: "report",
            text: stringContaining("Done report."),
            reportGeneration: 1,
          }),
        ]);
      }
      expect(notifications).toEqual([]);

      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({
        type: "completed",
        runs: [{ id: done.id, generation: 1, finalText: "Done report." }],
      });
      expect((yield* service.agentRead(MAIN, ["agent-missing-1", done.id])).missingIds).toEqual([
        "agent-missing-1",
      ]);
    });
  });

  it.effect("refuses a message resume while a covering subtree stop runs, then allows it", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent", nestingPolicy: nesting }));
      const finished = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "finished", nestingPolicy: nesting }),
      );
      const running = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "running", nestingPolicy: nesting }),
      );
      yield* completeLocalRun(service, fake.controls[1]!, finished.id, "Finished report.");
      const release = yield* Deferred.make<void>();
      fake.controls[2]!.gateRelease(release);
      const stopping = yield* service.stop(parent.id).pipe(Effect.forkScoped);
      yield* yieldUntil(() => latest(projections, running.id)?.state === "stopping");

      expect(
        yield* service.agentSend(MAIN, finished.id, "Keep going.").pipe(Effect.flip),
      ).toMatchObject({ code: "agent_unavailable" });
      expect(latest(projections, finished.id)?.state).toBe("completed");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      expect(yield* service.agentSend(MAIN, finished.id, "Keep going.")).toMatchObject({
        disposition: "resumed",
        run: { state: "running" },
      });
    });
  });

  it.effect("reads a resumed run's own failure, never its earlier assignment's report", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "worker" }));
      yield* completeLocalRun(service, fake.controls[0]!, run.id, "First assignment succeeded.");
      expect((yield* service.agentSend(MAIN, run.id, "Second assignment.")).disposition).toBe(
        "resumed",
      );
      fake.controls[1]!.exit(1);
      yield* yieldUntil(() => latest(projections, run.id)?.state === "failed");

      const [readout] = (yield* service.agentRead(MAIN, [run.id])).agents;
      expect(readout).toMatchObject({ kind: "run", state: "failed", source: "error" });
      expect(readout?.text).not.toContain("First assignment succeeded.");
    });
  });

  it.effect("records guidance still awaiting confirmation on both sender and receiver", () => {
    const backend = fakeNativeReportBackendLayer({
      steer: () =>
        Effect.fail(
          new SubagentProcessError({
            operation: "steer",
            code: PENDING_STEER_DELIVERY_CODE,
            pendingDelivery: true,
            message: "Guidance delivery is still being confirmed.",
          }),
        ),
    });
    const { projections, layer } = nativeReportServiceFixture(backend);
    return withService(layer, function* (service) {
      const sender = yield* service.start(nativeReportRequest({ name: "sender" }));
      const receiver = yield* service.start(nativeReportRequest({ name: "receiver" }));
      expect(
        yield* service.agentSend(asRun(sender), receiver.id, "Check the schema."),
      ).toMatchObject({ disposition: "guided", confirmed: false });
      expect(messageNotices(latest(projections, receiver.id))).toEqual([
        { direction: "in", peer: sender.id, text: "Check the schema." },
      ]);
      expect(messageNotices(latest(projections, sender.id))).toEqual([
        { direction: "out", peer: receiver.id, text: "Check the schema." },
      ]);
    });
  });

  it.effect("trims agent IDs, as call headings show them", () => {
    const main = fakeAgentMain();
    const { layer } = localServiceFixture({ agentMain: main.capabilities });
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "reporter" }));
      expect((yield* service.agentSend(asRun(run), ` ${MAIN_AGENT_ID} `, "Hi.")).to).toBe(
        MAIN_AGENT_ID,
      );
      expect(main.delivered).toHaveLength(1);
      const read = yield* service.agentRead(MAIN, [` ${run.id}`, `${MAIN_AGENT_ID} `]);
      expect(read.agents.map((agent) => agent.id)).toEqual([run.id, MAIN_AGENT_ID]);
      expect(read.missingIds).toEqual([]);
    });
  });

  it.effect("commits a claimed message after its sender is cancelled", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const sender = yield* service.start(request({ name: "sender" }));
      const target = yield* service.start(request({ name: "target" }));
      const gate = yield* Deferred.make<void>();
      fake.controls[1]!.gateNextSend("steer", gate);
      const sending = yield* service
        .agentSend(asRun(sender), target.id, "Finish the migration.")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => fake.controls[1]!.sent("steer"));
      yield* Fiber.interrupt(sending).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() => messageNotices(latest(projections, sender.id)).length === 1);
      expect(messageNotices(latest(projections, target.id))).toEqual([
        { direction: "in", peer: sender.id, text: "Finish the migration." },
      ]);
      expect(messageNotices(latest(projections, sender.id))).toEqual([
        { direction: "out", peer: target.id, text: "Finish the migration." },
      ]);
    });
  });
});

describe("the user's messages", () => {
  it.effect("answer a waiting run and steer a running one with the bare text", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const asking = yield* service.start(request({ name: "asking" }));
      const working = yield* service.start(request({ name: "working", task: "Review tests" }));
      yield* askQuestion(fake.controls[0]!, projections, asking.id, "question-1");

      const outcomes = yield* Effect.forEach(
        [asking.id, working.id],
        (id) => service.send(id, "Use the public API."),
        { concurrency: 2 },
      );
      expect(outcomes).toMatchObject([
        { disposition: "answered", run: { id: asking.id, state: "running" } },
        { disposition: "guided", run: { id: working.id, state: "running" } },
      ]);
      expect(fake.controls[0]?.ipc).toContainEqual({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: "question-1",
        ackId: anyString(),
        message: "Use the public API.",
      });
      expect(fake.controls[0]?.sent("steer")).toBe(false);
      expect(fake.controls[1]?.sentIpc("parent_reply")).toBe(false);
      expect(steerMessages(fake.controls[1])).toEqual(["Use the public API."]);
      expect(parentNotices(latest(projections, asking.id))).toEqual(["Reply: Use the public API."]);
      expect(parentNotices(latest(projections, working.id))).toEqual([
        "Guidance: Use the public API.",
      ]);
      expect(messageNotices(latest(projections, working.id))).toEqual([]);
      expect(latest(projections, working.id)?.messageCount).toBeUndefined();
    });
  });

  it.effect("never resume a paused or finished run", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const paused = yield* service.start(request({ name: "paused" }));
      const finished = yield* service.start(request({ name: "finished" }));
      expect((yield* service.interrupt(paused.id)).state).toBe("paused");
      yield* completeLocalRun(service, fake.controls[1]!, finished.id);

      for (const run of [paused, finished])
        expect(yield* service.send(run.id, "Keep going.").pipe(Effect.flip)).toMatchObject({
          code: "agent_unavailable",
          message: stringContaining("resume it"),
        });
      expect(yield* runView(service, paused.id)).toMatchObject({
        state: "paused",
        assignmentEpoch: 1,
      });
      expect(yield* runView(service, finished.id)).toMatchObject({
        state: "completed",
        assignmentEpoch: 1,
      });
      expect(fake.controls).toHaveLength(2);
      expect(promptMessages(fake.controls[0])).not.toContain("Keep going.");
    });
  });

  it.effect("apply only while the run is as the user saw it", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "changing" }));
      const expected = captureSubagentControlExpectation(yield* runView(service, run.id));
      yield* askQuestion(fake.controls[0]!, projections, run.id, "question-later");

      expect(
        yield* service.send(run.id, "Old guidance.", expected).pipe(Effect.flip),
      ).toMatchObject({ code: "run_control_changed" });
      expect(fake.controls[0]?.sent("steer")).toBe(false);
      expect(fake.controls[0]?.sentIpc("parent_reply")).toBe(false);
    });
  });

  it.effect("refuse another message while a reply is in flight", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "reply-in-flight" }));
      yield* askQuestion(fake.controls[0]!, projections, run.id, "question-in-flight");
      const replyGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpcType("parent_reply", replyGate);
      const replying = yield* service
        .send(run.id, "Proceed.")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* yieldUntil(() => fake.controls[0]?.sentIpc("parent_reply") === true);

      expect(yield* service.send(run.id, "Proceed again.").pipe(Effect.flip)).toMatchObject({
        code: "reply_in_flight",
      });
      expect(fake.controls[0]?.sent("steer")).toBe(false);

      yield* Deferred.succeed(replyGate, undefined);
      expect(yield* Fiber.join(replying)).toMatchObject({ disposition: "answered" });
      expect(
        fake.controls[0]?.ipc.filter((message) => message.type === "parent_reply"),
      ).toHaveLength(1);
    });
  });

  it.effect("roll back a definitely unsent reply and keep the question answerable", () => {
    const { fake, projections, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "unsent-reply" }));
      yield* askQuestion(fake.controls[0]!, projections, run.id, "unsent-question");

      fake.controls[0]?.failNextIpc("transport_not_sent");
      expect(yield* service.send(run.id, "Proceed.").pipe(Effect.flip)).toMatchObject({
        code: "reply_send_failed",
      });
      const status = yield* runView(service, run.id);
      expect(status.state).toBe("waiting_for_parent");
      expect(status.question).toMatchObject({ requestId: "unsent-question" });
      expect(status.warning).toBeUndefined();

      expect(yield* service.send(run.id, "Proceed.")).toMatchObject({
        disposition: "answered",
        run: { state: "running" },
      });
      expect(
        fake.controls[0]?.ipc.flatMap((message) =>
          message.type === "parent_reply" ? [[message.requestId, message.message]] : [],
        ),
      ).toEqual([
        ["unsent-question", "Proceed."],
        ["unsent-question", "Proceed."],
      ]);
    });
  });

  it.effect("share the agent messages' size limit", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request({ name: "bounded-message" }));
      for (const send of [
        service.send(run.id, "x".repeat(16_385)),
        service.agentSend(MAIN, run.id, "x".repeat(16_385)),
      ])
        expect(yield* send.pipe(Effect.flip)).toMatchObject({ code: "message_too_large" });
      expect(fake.controls[0]?.sent("steer")).toBe(false);
    });
  });
});
