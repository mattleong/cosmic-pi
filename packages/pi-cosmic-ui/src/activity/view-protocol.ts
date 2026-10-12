import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, querySessionCapability } from "pi-cosmic-core";
import type { ActivityEvents } from "./protocol.ts";
import { ActivityError } from "./service.ts";

export const ACTIVITY_VIEW_DISCOVER = "cosmic-ui:activity:view:discover:v1";
export type ActivitySection = "workflows" | "subagents" | "tasks";
export interface ActivityViewCapability {
  readonly open: (section: ActivitySection, signal?: AbortSignal) => Promise<boolean>;
}

const isViewOpener = <Value>(
  value: Value,
): value is Value & ((section: ActivitySection, signal?: AbortSignal) => void) =>
  Predicate.isFunction(value);

const ViewCapability = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  hostToken: Schema.ObjectKeyword,
  open: Schema.declare(isViewOpener),
});
export const isActivitySection = (section: string): section is ActivitySection =>
  section === "workflows" || section === "subagents" || section === "tasks";

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
            if (!isActivitySection(section)) throw new ActivityError({ reason: "invalid" });
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
