/** Host event registration and lifecycle-event composition. */
import { makeSessionLifecycle } from "./events/session.ts";
import { registerTrajectoryEvents } from "./events/trajectory.ts";
import { registerTurnEvents } from "./events/turn.ts";
import type { EventsDeps } from "./events/types.ts";

export type { EventsDeps } from "./events/types.ts";

// The four session lifecycle events (session_start/shutdown/compact/tree) reach the controller
// through its dedicated lifecycle methods, never through the forwarded event-handler map.
export const registerLifecycleEvents = (d: EventsDeps) => {
  const lifecycle = makeSessionLifecycle(d);

  registerTurnEvents(d);
  registerTrajectoryEvents(d);

  return lifecycle;
};
