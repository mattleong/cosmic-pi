/** Source-only, test-runner-independent activity host fake for producer tests. */
import {
  ACTIVITY_DISCOVER,
  ACTIVITY_EVENT,
  ACTIVITY_HOST,
  type ActivityEnvelope,
  type ActivityEvents,
} from "./protocol.ts";

/**
 * An in-memory event bus whose host answers discovery for `sessionId`, records the latest
 * envelope, and acknowledges each registration.
 */
export function fakeActivityHost(sessionId = "session") {
  const hostToken = {};
  const listeners = new Map<string, Set<Parameters<ActivityEvents["on"]>[1]>>();
  let envelope: ActivityEnvelope | undefined;
  let capability: ActivityEnvelope | undefined;
  const events: ActivityEvents = {
    on: (name, handler) => {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(handler);
      listeners.set(name, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
    emit: (name, value) => {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
  events.on(ACTIVITY_DISCOVER, () =>
    events.emit(ACTIVITY_HOST, { version: 1, sessionId, hostToken, available: true }),
  );
  events.on(ACTIVITY_EVENT, (value) => {
    // SAFETY: The fake captures only envelopes emitted by the producer's protocol adapter.
    envelope = value as ActivityEnvelope;
    if (envelope.operation === "register") {
      capability = envelope;
      envelope.acknowledge?.(true);
    }
  });
  return { events, hostToken, get: () => envelope, capability: () => capability };
}
