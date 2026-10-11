import type * as Effect from "effect/Effect";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import type { ActivityEvents } from "../activity/protocol.ts";
import { ActivityError } from "../activity/service.ts";
import {
  ACTIVITY_VIEW_DISCOVER,
  isActivitySection,
  type ActivitySection,
} from "../activity/view-protocol.ts";

const viewDiscovery = makeSessionCapabilityProtocol({ version: 1, maxSessionIdChars: 256 });

export type ActivityHostRun = <A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
) => Promise<A>;

export interface ActivityViewInstallation {
  readonly sessionId: string;
  readonly hostToken: object;
  readonly current: () => boolean;
  readonly open: (section: ActivitySection, signal?: AbortSignal) => Promise<boolean>;
}

export function installActivityView(
  events: ActivityEvents,
  installation: ActivityViewInstallation,
): () => void {
  let active = true;
  const current = () => active && installation.current();
  const unsubscribe = events.on(ACTIVITY_VIEW_DISCOVER, (data) => {
    const query = viewDiscovery.normalizeQuery(data);
    if (!query || query.sessionId !== installation.sessionId || !current()) return;
    query.respond({
      version: 1,
      sessionId: installation.sessionId,
      hostToken: installation.hostToken,
      open: (section: ActivitySection, signal?: AbortSignal) =>
        Promise.resolve().then(() => {
          if (!current() || signal?.aborted) throw new ActivityError({ reason: "stale" });
          if (!isActivitySection(section)) throw new ActivityError({ reason: "invalid" });
          return installation.open(section, signal);
        }),
    });
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
