import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  decodeUnknownOrUndefined,
  makeSessionCapabilityProtocol,
  querySessionCapability,
} from "pi-cosmic-core";
import type { ActivityEvents } from "../activity/protocol.ts";
import { ActivityError } from "../activity/service.ts";
import {
  ACTIVITY_VIEW_DISCOVER,
  type ActivitySection,
  type ActivityViewCapability,
} from "../activity/view-protocol.ts";

const viewDiscovery = makeSessionCapabilityProtocol({ version: 1, maxSessionIdChars: 256 });
const ViewCapability = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  hostToken: Schema.ObjectKeyword,
  open: Schema.declare(Predicate.isFunction),
});
const sectionIsValid = (section: string): section is ActivitySection =>
  section === "workflows" || section === "subagents" || section === "tasks";

/** Checked synchronous discovery; only a plain checked Promise capability crosses events. */
export function discoverActivityView(
  events: ActivityEvents,
  sessionId: string,
): ActivityViewCapability | undefined {
  const found = querySessionCapability(
    events,
    ACTIVITY_VIEW_DISCOVER,
    { version: 1, sessionId },
    <Candidate>(candidate: Candidate) => {
      const decoded = decodeUnknownOrUndefined(ViewCapability, candidate);
      if (!decoded || decoded.sessionId !== sessionId) return undefined;
      const open = decoded.open;
      return Object.freeze({
        open: (section: ActivitySection, signal?: AbortSignal): Promise<boolean> =>
          Promise.resolve().then(() => {
            if (!sectionIsValid(section)) throw new ActivityError({ reason: "invalid" });
            if (signal?.aborted) throw new ActivityError({ reason: "stale" });
            return Promise.resolve(open(section, signal)).then(<Output>(output: Output) => {
              const result = decodeUnknownOrUndefined(Schema.Boolean, output);
              if (result === undefined) throw new ActivityError({ reason: "failed" });
              return result;
            });
          }),
      });
    },
    2,
  );
  return !found.failed && found.candidates.length === 1 ? found.candidates[0] : undefined;
}

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

/** Answers view discovery for one installation, not merely its reusable session ID. */
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
          if (!sectionIsValid(section)) throw new ActivityError({ reason: "invalid" });
          return installation.open(section, signal);
        }),
    });
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
