import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { type AgentCaller, MAIN_AGENT_ID } from "../../src/run/agent-messaging.ts";
import { SubagentNotFoundError } from "../../src/run/errors.ts";
import type { SubagentProjection, SubagentRunView } from "../../src/run/model.ts";
import { objectContaining, stringContaining } from "../support/matchers.ts";
import { fakeAgentMain } from "./fixtures/agent-main.ts";
import {
  acknowledgeCompletions,
  assistantMessageEndFrame,
  completeLocalRun,
  contactParentFrame,
  fakeChildLayer,
  type FakeChildControl,
  localServiceFixture,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
  request,
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

  it.effect("lets only the direct parent answer a waiting run; others guide it", () => {
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

      const fromMain = yield* service.agentSend(MAIN, child.id, "Use v2.");
      expect(fromMain.disposition).toBe("guided");
      const fromSibling = yield* service.agentSend(asRun(sibling), child.id, "Prefer v1.");
      expect(fromSibling.disposition).toBe("guided");
      expect(childControl.sentIpc("parent_reply")).toBe(false);
      expect(latest(projections, child.id)?.state).toBe("waiting_for_parent");

      const fromParent = yield* service.agentSend(asRun(parent), child.id, "Use the public API.");
      expect(fromParent).toMatchObject({ disposition: "answered", run: { state: "running" } });
      expect(
        childControl.sentIpc("parent_reply", (reply) => reply.message === "Use the public API."),
      ).toBe(true);
      expect(steerMessages(childControl)).toHaveLength(2);

      // The main agent is the direct parent of top-level runs.
      yield* askQuestion(fake.controls[1]!, projections, sibling.id, "question-2");
      expect((yield* service.agentSend(MAIN, sibling.id, "Go ahead.")).disposition).toBe(
        "answered",
      );
    });
  });

  it.effect("resumes a finished Pi run from any sender and names the resumer to its parent", () => {
    const { fake, projections, notifications, layer } = localServiceFixture({
      notify: acknowledgeCompletions,
    });
    return withService(layer, function* (service) {
      const worker = yield* service.start(request({ name: "worker" }));
      const peer = yield* service.start(request({ name: "peer" }));
      yield* completeLocalRun(service, fake.controls[0]!, worker.id, "First report.");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({ runs: [{ id: worker.id }] });
      expect(notifications[0]?.type === "completed" && notifications[0].runs[0]?.resumedBy).toBe(
        undefined,
      );

      const resumed = yield* service.agentSend(asRun(peer), worker.id, "Also cover retries.");
      expect(resumed).toMatchObject({
        disposition: "resumed",
        run: { id: worker.id, state: "running", assignmentEpoch: 2 },
      });
      // A parent awaiting the run sees who resumed it.
      expect((yield* service.status(worker.id)).resumedBy).toEqual(stringContaining(peer.id));
      const resumedControl = fake.controls[2]!;
      expect(resumedControl.launch.resumeSessionFile).toBe("/tmp/child-session.jsonl");
      expect(promptMessages(resumedControl)).toEqual([stringContaining(peer.id)]);
      expect(messageNotices(latest(projections, worker.id))).toContainEqual({
        direction: "in",
        peer: peer.id,
        text: "Also cover retries.",
      });

      yield* completeLocalRun(service, resumedControl, worker.id, "Second report.");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 2);
      const second = notifications[1];
      expect(second?.type === "completed" && second.runs[0]).toMatchObject({
        id: worker.id,
        generation: 2,
        finalText: "Second report.",
        resumedBy: stringContaining(peer.id),
      });
    });
  });

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
          expect((yield* send(text)).disposition).toBe("woken");
        expect(main.delivered.every((delivery) => delivery.startTurn)).toBe(true);
        expect(main.delivered[0]?.frame).toMatchObject({ from: run.id, to: MAIN_AGENT_ID });
        expect(main.delivered[0]?.frame.content).toContain("one");

        main.control.state = "busy";
        expect((yield* send("six")).disposition).toBe("queued");
        main.control.held = true;
        expect((yield* send("seven")).disposition).toBe("held");

        main.control.retired = true;
        expect(yield* send("eight").pipe(Effect.flip)).toMatchObject({ code: "agent_unavailable" });
      });
    },
  );

  it.effect("resumes a finished run from a peer's messages as often as it is sent one", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const worker = yield* service.start(request({ name: "worker" }));
      const peer = yield* service.start(request({ name: "peer" }));
      yield* completeLocalRun(service, fake.controls[0]!, worker.id);
      for (let round = 0; round < 5; round += 1) {
        expect((yield* service.agentSend(asRun(peer), worker.id, "Again.")).disposition).toBe(
          "resumed",
        );
        yield* completeLocalRun(service, fake.controls.at(-1)!, worker.id);
      }
    });
  });

  it.effect("refuses resumes by agent messages once the session reached its spend limit", () => {
    const fake = fakeChildLayer();
    const { projections, layer } = localServiceFixture(
      {},
      fake,
      profileLayerFor({ version: 6, sessionSpendLimit: 1 }),
    );
    return withService(layer, function* (service) {
      const worker = yield* service.start(request({ name: "worker" }));
      const peer = yield* service.start(request({ name: "peer" }));
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
        yield* service.agentSend(asRun(peer), worker.id, "One more pass.").pipe(Effect.flip),
      ).toMatchObject({ code: "agent_spend_limit" });
      expect(yield* service.status(worker.id)).toMatchObject({
        state: "completed",
        assignmentEpoch: 1,
      });
      expect(fake.controls).toHaveLength(2);
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
      expect((yield* service.status(run.id)).state).toBe("running");
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
            text: "Done report.",
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
