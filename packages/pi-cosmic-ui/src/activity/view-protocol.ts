import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { querySessionCapability } from "pi-cosmic-core/session-capability";
import type { ActivityEvents } from "./protocol.ts";
import { ActivityError } from "./service.ts";

export const ACTIVITY_VIEW_DISCOVER = "cosmic-ui:activity:view:discover:v1";
const ActivitySectionSchema = Schema.Literals(["subagents", "tasks"]);
export type ActivitySection = typeof ActivitySectionSchema.Type;
export interface ActivityViewCapability {
  readonly open: (section: ActivitySection, signal?: AbortSignal) => Promise<boolean>;
}

const ViewCapability = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  hostToken: Schema.ObjectKeyword,
  open: ForeignCallable<[section: ActivitySection, signal?: AbortSignal]>(),
});
export const isActivitySection = Schema.is(ActivitySectionSchema);

const decodeViewCapability = decodeUnknownOrUndefined(ViewCapability);
const decodeOpened = decodeUnknownOrUndefined(Schema.Boolean);

export function discoverActivityView(
  events: ActivityEvents,
  sessionId: string,
): ActivityViewCapability | undefined {
  const found = querySessionCapability(
    events,
    ACTIVITY_VIEW_DISCOVER,
    { version: 1, sessionId },
    (candidate) => {
      const decoded = decodeViewCapability(candidate);
      if (!decoded || decoded.sessionId !== sessionId) return undefined;
      const open = decoded.open;
      return Object.freeze({
        open: (section: ActivitySection, signal?: AbortSignal): Promise<boolean> =>
          Promise.resolve().then(() => {
            if (!isActivitySection(section)) throw ActivityError.make({ reason: "invalid" });
            if (signal?.aborted) throw ActivityError.make({ reason: "stale" });
            return Promise.resolve<unknown>(open(section, signal)).then((output) => {
              const result = decodeOpened(output);
              if (result === undefined) throw ActivityError.make({ reason: "failed" });
              return result;
            });
          }),
      });
    },
    2,
  );
  return !found.failed && found.candidates.length === 1 ? found.candidates[0] : undefined;
}
