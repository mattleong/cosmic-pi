import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { McpBoundaryError } from "../../src/client/errors.ts";
import type { McpSettings } from "../../src/config/model.ts";
import { McpAdmission, type AdmissionTicket } from "../../src/connection/admission.ts";

const settings: McpSettings = {
  enabled: true,
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 600_000,
  maxConcurrent: 2,
  maxPerServer: 1,
  maxQueued: 2,
};
const issue = (state: McpAdmission, server: string, now = 0): AdmissionTicket => {
  const ticket = state.issue(server, now);
  if (ticket instanceof McpBoundaryError) throw ticket;
  return ticket;
};

it("bounds total preparation tickets and keeps the initial deadline", () => {
  const state = new McpAdmission(() => settings);
  const first = issue(state, "a", 50);
  expect(first.deadline).toBe(60_050);
  issue(state, "a");
  issue(state, "b");
  issue(state, "b");
  expect(state.issue("c", 10)).toMatchObject({ kind: "busy", outcome: "not-sent" });
  state.release(first);
  expect(issue(state, "c", 70).deadline).toBe(60_070);
});

it.effect("serves eligible servers fairly without a nested permit wait", () =>
  Effect.gen(function* () {
    const state = new McpAdmission(() => settings);
    const first = state.enqueue(issue(state, "a"));
    const second = state.enqueue(issue(state, "a"));
    const third = state.enqueue(issue(state, "b"));
    const fourth = state.enqueue(issue(state, "b"));
    yield* Deferred.await(first.ready);
    yield* Deferred.await(third.ready);
    expect(state.snapshot()).toEqual({ active: 2, queued: 2 });
    state.finish(first);
    yield* Deferred.await(second.ready);
    expect(fourth.state).toBe("queued");
    state.finish(third);
    yield* Deferred.await(fourth.ready);
    expect(state.snapshot()).toEqual({ active: 2, queued: 0 });
  }),
);

it.effect("bounds a saturated single-server queue and releases cancelled waiters", () =>
  Effect.gen(function* () {
    const state = new McpAdmission(() => settings);
    const first = state.enqueue(issue(state, "a"));
    const queuedTicket = issue(state, "a");
    const queued = state.enqueue(queuedTicket);
    state.enqueue(issue(state, "a"));
    const overflow = state.enqueue(issue(state, "a"));
    expect(yield* Effect.result(Deferred.await(overflow.ready))).toMatchObject({
      _tag: "Failure",
      failure: { kind: "busy" },
    });
    state.release(queuedTicket);
    expect(yield* Effect.result(Deferred.await(queued.ready))).toMatchObject({
      _tag: "Failure",
      failure: { kind: "stale" },
    });
    expect(state.snapshot()).toEqual({ active: 1, queued: 1 });
    state.finish(first);
    state.finish(first);
    expect(state.snapshot()).toEqual({ active: 1, queued: 0 });
  }),
);

it.effect(
  "bounds prerequisite owners independently without expanding remote permits or the zero queue",
  () =>
    Effect.gen(function* () {
      const state = new McpAdmission(() => ({
        ...settings,
        maxConcurrent: 1,
        maxPerServer: 1,
        maxQueued: 0,
      }));
      const caller = issue(state, "a");
      const dependency = state.issueDependency("a", 10);
      if (dependency instanceof McpBoundaryError) return yield* dependency;
      const active = state.enqueue(dependency);
      yield* Deferred.await(active.ready);
      expect(state.issueDependency("b", 10)).toMatchObject({ kind: "busy" });
      expect(state.issue("b", 10)).toMatchObject({ kind: "busy" });
      state.release(caller);
      const replacement = issue(state, "b");
      const overflow = state.enqueue(replacement);
      expect(yield* Effect.result(Deferred.await(overflow.ready))).toMatchObject({
        failure: { kind: "busy" },
      });
      expect(state.snapshot()).toEqual({ active: 1, queued: 0 });
      state.cancel(dependency);
      expect(state.issueDependency("b", 20)).toMatchObject({ kind: "busy" });
      state.finish(active);
      state.release(dependency);
      state.release(replacement);
      const fresh = state.issueDependency("b", 30);
      if (fresh instanceof McpBoundaryError) return yield* fresh;
      const dispatch = state.enqueue(fresh);
      yield* Deferred.await(dispatch.ready);
      state.finish(dispatch);
      state.release(fresh);
      expect(state.snapshot()).toEqual({ active: 0, queued: 0 });
    }),
);

it.effect("revocation wakes queued work but retains active permits through cleanup", () =>
  Effect.gen(function* () {
    const state = new McpAdmission(() => settings);
    const activeTicket = issue(state, "a");
    activeTicket.outcome = "unknown";
    const active = state.enqueue(activeTicket);
    const queued = state.enqueue(issue(state, "a"));
    const sibling = state.enqueue(issue(state, "b"));
    state.revoke("a");
    expect(yield* Effect.result(Deferred.await(activeTicket.revoked))).toMatchObject({
      failure: { outcome: "unknown" },
    });
    expect(yield* Effect.result(Deferred.await(queued.ready))).toMatchObject({
      failure: { kind: "stale" },
    });
    yield* Deferred.await(sibling.ready);
    expect(state.snapshot()).toEqual({ active: 2, queued: 0 });
    state.finish(active);
    expect(state.snapshot()).toEqual({ active: 1, queued: 0 });
  }),
);
