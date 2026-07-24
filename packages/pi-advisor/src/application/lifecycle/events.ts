/** Host event registration and lifecycle-event composition. */
import * as Effect from "effect/Effect";
import { captureAdvisorSessionInputEffect } from "../../boundary/host-context.ts";
import { extensionError } from "../controller-types.ts";
import { makeSessionLifecycle } from "./events/session.ts";
import { registerTrajectoryEvents } from "./events/trajectory.ts";
import { registerTurnEvents } from "./events/turn.ts";
import type { EventsDeps } from "./events/types.ts";

export type { EventsDeps } from "./events/types.ts";

export const registerLifecycleEvents = (d: EventsDeps) => {
  const lifecycle = makeSessionLifecycle(d);

  d.hostBindings.registerEvent("session_start", (_event, ctx) =>
    d.runSessionEffect(
      captureAdvisorSessionInputEffect(ctx).pipe(
        Effect.mapError(extensionError("session input capture")),
        Effect.flatMap(lifecycle.sessionInitializeEffect),
      ),
    ),
  );
  d.hostBindings.registerEvent("session_shutdown", () =>
    d.runSessionEffect(lifecycle.sessionShutdownEffect()),
  );
  d.hostBindings.registerEvent("session_compact", (_event, ctx) =>
    d.runSessionEffect(lifecycle.compactEffect(ctx)),
  );
  d.hostBindings.registerEvent("session_tree", (_event, ctx) =>
    d.runSessionEffect(lifecycle.treeEffect(ctx)),
  );

  registerTurnEvents(d);
  registerTrajectoryEvents(d);

  return lifecycle;
};
