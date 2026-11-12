import * as Schema from "effect/Schema";
import {
  ACTIVITY_DISCOVER,
  ACTIVITY_EVENT,
  ACTIVITY_HOST,
  ActivityEnvelopeSchema,
  type ActivityEnvelope,
  type ActivityEvents,
} from "./protocol.ts";

const isActivityEnvelope = Schema.is(ActivityEnvelopeSchema);

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
    if (!isActivityEnvelope(value)) return;
    envelope = value;
    if (value.operation === "register") {
      capability = value;
      value.acknowledge?.(true);
    }
  });
  return { events, hostToken, get: () => envelope, capability: () => capability };
}
