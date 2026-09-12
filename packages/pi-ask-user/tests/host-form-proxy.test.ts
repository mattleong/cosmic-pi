import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import { it } from "@effect/vitest";
import { registerOwnedFormCapability } from "../src/boundary/host-form-proxy.ts";
import {
  queryOwnedFormCapability,
  type FormOutcome,
  type QuestionnaireEvents,
} from "../src/protocol.ts";
import { controlled } from "./support/host.ts";

const request = { kind: "form", message: "private", fields: [] } as const;
const owner = {
  extensionId: "pi-mcp",
  operationId: "operation",
  requestId: "request",
  label: "MCP",
};
const events = (): QuestionnaireEvents => {
  const callbacks = new Map<string, Set<Parameters<QuestionnaireEvents["on"]>[1]>>();
  return {
    on: (name, listener) => {
      const listeners = callbacks.get(name) ?? new Set();
      listeners.add(listener);
      callbacks.set(name, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (name, data) => {
      for (const callback of callbacks.get(name) ?? []) callback(data);
    },
  };
};

it.effect(
  "separates extension ownership, rejects collisions and joins exact cancellation cleanup",
  () =>
    Effect.gen(function* () {
      const bus = events();
      const runs: {
        signal: AbortSignal;
        completion: ReturnType<typeof controlled<FormOutcome>>;
      }[] = [];
      const dispose = registerOwnedFormCapability({
        events: bus,
        sessionId: "session",
        generation: "one",
        isCurrent: () => true,
        canQueue: () => true,
        run: (_effect, signal) => {
          const completion = controlled<FormOutcome>();
          runs.push({ signal, completion });
          return completion.promise;
        },
      });
      expect(queryOwnedFormCapability(bus, "foreign")).toBeUndefined();
      const capability = queryOwnedFormCapability(bus, "session")!;
      const first = capability.ask(request, owner, new AbortController().signal);
      const firstRejected = expect(first).rejects.toBeDefined();
      yield* Effect.promise(() =>
        expect(
          capability.ask(
            request,
            { ...owner, label: "changed label" },
            new AbortController().signal,
          ),
        ).rejects.toBeDefined(),
      );
      const second = capability.ask(
        request,
        { ...owner, extensionId: "other" },
        new AbortController().signal,
      );
      let acknowledged = false;
      const cancellation = capability.cancel(owner).then(() => {
        acknowledged = true;
      });
      expect(runs[0]!.signal.aborted).toBe(true);
      expect(runs[1]!.signal.aborted).toBe(false);
      yield* Effect.promise(() => Promise.resolve());
      expect(acknowledged).toBe(false);
      runs[0]!.completion.resolve({ action: "accept", content: {} });
      yield* Effect.promise(() => cancellation);
      yield* Effect.promise(() => firstRejected);
      runs[1]!.completion.resolve({ action: "decline" });
      expect(yield* Effect.promise(() => second)).toEqual({ action: "decline" });
      dispose();
    }),
);

it.effect("rejects stale captured capabilities and late answers after generation revocation", () =>
  Effect.gen(function* () {
    const bus = events();
    let current = true;
    const completion = controlled<FormOutcome>();
    const dispose = registerOwnedFormCapability({
      events: bus,
      sessionId: "session",
      generation: "one",
      isCurrent: () => current,
      canQueue: () => true,
      run: () => completion.promise,
    });
    const capability = queryOwnedFormCapability(bus, "session")!;
    const pending = capability.ask(request, owner, new AbortController().signal);
    const rejected = expect(pending).rejects.toBeDefined();
    current = false;
    expect(queryOwnedFormCapability(bus, "session")).toBeUndefined();
    yield* Effect.promise(() =>
      expect(
        capability.ask(request, { ...owner, requestId: "next" }, new AbortController().signal),
      ).rejects.toBeDefined(),
    );
    completion.resolve({ action: "accept", content: {} });
    yield* Effect.promise(() => rejected);
    dispose();
  }),
);

it.effect("bounds live owned calls and honors prompt admission without running hidden work", () =>
  Effect.gen(function* () {
    const bus = events();
    const completion = controlled<FormOutcome>();
    let canQueue = false;
    const run = vi.fn(() => completion.promise);
    const dispose = registerOwnedFormCapability({
      events: bus,
      sessionId: "session",
      generation: "one",
      isCurrent: () => true,
      canQueue: () => canQueue,
      run,
    });
    const capability = queryOwnedFormCapability(bus, "session")!;
    yield* Effect.promise(() =>
      expect(capability.ask(request, owner, new AbortController().signal)).rejects.toBeDefined(),
    );
    expect(run).not.toHaveBeenCalled();
    canQueue = true;
    const pending = Array.from({ length: 16 }, (_, i) =>
      capability.ask(request, { ...owner, requestId: String(i) }, new AbortController().signal),
    );
    yield* Effect.promise(() =>
      expect(capability.ask(request, owner, new AbortController().signal)).rejects.toBeDefined(),
    );
    completion.resolve({ action: "cancel" });
    yield* Effect.promise(() => Promise.all(pending));
    dispose();
  }),
);
