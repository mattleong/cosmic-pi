import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import { detachActivityItem } from "./detach.ts";
import { ACTIVITY_LIMITS } from "./limits.ts";
export { ACTIVITY_LIMITS } from "./limits.ts";

const ACTIVITY_VERSION = 1 as const;
export const ACTIVITY_EVENT = "cosmic-ui:activity:v1";
export const ACTIVITY_DISCOVER = "cosmic-ui:activity:discover:v1";
export const ACTIVITY_HOST = "cosmic-ui:activity:host:v1";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(ACTIVITY_LIMITS.id));
const Text = Schema.String.check(Schema.isMaxLength(ACTIVITY_LIMITS.text));
const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const ActivityStartingSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(ACTIVITY_LIMITS.starting),
);
const ActivityFields = {
  id: Id,
  kind: Schema.Literals(["agent", "command", "question"]),
  title: Schema.String.check(Schema.isMaxLength(ACTIVITY_LIMITS.title)),
  profile: Schema.optional(Schema.String.check(Schema.isMaxLength(ACTIVITY_LIMITS.profile))),
  route: Schema.optional(Schema.String.check(Schema.isMaxLength(ACTIVITY_LIMITS.route))),
  awaited: Schema.optional(Schema.Boolean),
  revision: Id,
  startedAt: Schema.optional(Timestamp),
  endedAt: Schema.optional(Timestamp),
  updatedAt: Schema.optional(Timestamp),
  parent: Schema.optional(Schema.Struct({ providerId: Id, itemId: Id })),
  summary: Schema.optional(Text),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(ACTIVITY_LIMITS.detail))),
  actions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        label: Text,
        confirmation: Schema.optional(Text),
        handoff: Schema.optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(ACTIVITY_LIMITS.actions)),
  ),
};
const ActivityItemSchema = Schema.Union([
  Schema.Struct({
    ...ActivityFields,
    status: Schema.Literal("needs-input"),
    inputTarget: Schema.Literals(["user", "parent"]),
    blockedReason: Schema.optional(Schema.Never),
  }),
  Schema.Struct({
    ...ActivityFields,
    status: Schema.Literal("blocked"),
    inputTarget: Schema.optional(Schema.Never),
    blockedReason: Schema.optional(
      Schema.Literals(["parent-review", "file-access-review", "file-access", "write-containment"]),
    ),
  }),
  Schema.Struct({
    ...ActivityFields,
    status: Schema.Literals(["pending", "running", "stopping", "done", "failed", "cancelled"]),
    inputTarget: Schema.optional(Schema.Never),
    blockedReason: Schema.optional(Schema.Never),
  }),
]);
export type ActivityItem = typeof ActivityItemSchema.Type;
export const ActivitySnapshotSchema = Schema.Array(ActivityItemSchema).check(
  Schema.isMaxLength(ACTIVITY_LIMITS.items),
);
export const activityKey = (providerId: string, itemId: string): string =>
  JSON.stringify([providerId, itemId]);

export type ActivityEvents = Pick<ExtensionAPI["events"], "on" | "emit">;
export interface ActivityProviderOptions {
  readonly sessionId: string;
  readonly providerId: string;
  readonly snapshot: () => readonly ActivityItem[];
  readonly starting?: () => number;
  readonly invoke: (
    itemId: string,
    actionId: string,
    revision: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly getDetail?: (itemId: string, revision: string, signal: AbortSignal) => Promise<string>;
  readonly onAvailability?: (available: boolean) => void;
}
export interface ActivityProviderRegistration {
  publish(): void;
  dispose(): void;
  isAvailable(): boolean;
}
export const ActivityEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  providerId: Id,
  operation: Schema.Literals(["register", "publish", "revoke"]),
  token: Schema.ObjectKeyword,
  hostToken: Schema.ObjectKeyword,
  items: Schema.optional(Schema.Unknown),
  starting: Schema.optional(Schema.Unknown),
  invoke: Schema.optional(ForeignCallable<Parameters<ActivityProviderOptions["invoke"]>>()),
  getDetail:
    Schema.optional(
      ForeignCallable<Parameters<NonNullable<ActivityProviderOptions["getDetail"]>>>(),
    ),
  acknowledge: Schema.optional(ForeignCallable<[available: boolean]>()),
});
export type ActivityEnvelope = typeof ActivityEnvelopeSchema.Type;
// Providers publish their typed callbacks; hosts admit them only as checked foreign callables.
type PublishedActivityEnvelope = Omit<ActivityEnvelope, "invoke" | "getDetail" | "acknowledge"> & {
  readonly invoke?: ActivityProviderOptions["invoke"];
  readonly getDetail?: ActivityProviderOptions["getDetail"];
  readonly acknowledge?: (available: boolean) => void;
};
const ActivityHostSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Id,
  hostToken: Schema.ObjectKeyword,
  available: Schema.Boolean,
});
const isActivityHost = Schema.is(ActivityHostSchema);

const detachedSummaries = (items: readonly ActivityItem[]): readonly ActivityItem[] =>
  Arr.map(items.slice(0, ACTIVITY_LIMITS.items), (item) =>
    detachActivityItem(item, (detail) =>
      sanitizeDiagnosticContent(Fn.pipe(detail, Str.slice(0, ACTIVITY_LIMITS.detail)), {
        maximumLength: ACTIVITY_LIMITS.detail,
      }),
    ),
  );

const unavailable = () => Promise.reject(new Error("Activity provider unavailable."));

export function registerActivityProvider(
  events: ActivityEvents,
  options: ActivityProviderOptions,
): ActivityProviderRegistration {
  const token = {};
  let disposed = false;
  let available = false;
  let hostToken: object | undefined;
  const acknowledge = (next: boolean) => {
    if (disposed || available === next) return;
    available = next;
    try {
      options.onAvailability?.(next);
    } catch {}
  };
  const send = (operation: ActivityEnvelope["operation"]) => {
    if (disposed || !hostToken) return;
    const registrationHost = hostToken;
    const { getDetail } = options;
    const usable = (signal: AbortSignal) =>
      !disposed && available && hostToken === registrationHost && !signal.aborted;
    try {
      events.emit(ACTIVITY_EVENT, {
        version: ACTIVITY_VERSION,
        sessionId: options.sessionId,
        providerId: options.providerId,
        token,
        hostToken: registrationHost,
        operation,
        ...(operation !== "revoke" && {
          items: detachedSummaries(options.snapshot()),
          starting: options.starting?.() ?? 0,
        }),
        ...(operation === "register" && {
          invoke: (itemId: string, actionId: string, revision: string, signal: AbortSignal) =>
            usable(signal) ? options.invoke(itemId, actionId, revision, signal) : unavailable(),
          acknowledge: (next: boolean) => {
            if (hostToken === registrationHost) acknowledge(next);
          },
          ...(getDetail && {
            getDetail: (itemId: string, revision: string, signal: AbortSignal) =>
              usable(signal) ? getDetail(itemId, revision, signal) : unavailable(),
          }),
        }),
      } satisfies PublishedActivityEnvelope);
    } catch {
      acknowledge(false);
    }
  };
  const unsubscribe = events.on(ACTIVITY_HOST, (data) => {
    try {
      if (!isActivityHost(data) || data.sessionId !== options.sessionId) return;
      if (data.available) {
        if (hostToken !== data.hostToken) acknowledge(false);
        hostToken = data.hostToken;
        send("register");
      } else if (hostToken === data.hostToken) acknowledge(false);
    } catch {}
  });
  try {
    events.emit(ACTIVITY_DISCOVER, { version: ACTIVITY_VERSION, sessionId: options.sessionId });
  } catch {}
  return {
    publish: () => send(available ? "publish" : "register"),
    isAvailable: () => available && !disposed,
    dispose: () => {
      if (disposed) return;
      send("revoke");
      acknowledge(false);
      disposed = true;
      unsubscribe();
    },
  };
}

interface RevisionedActivityProviderOptions {
  readonly sessionId: string;
  readonly providerId: string;
  readonly isCurrent: () => boolean;
  readonly items: () => readonly ActivityItem[];
  readonly detail: (item: ActivityItem) => string;
  readonly act: (
    item: ActivityItem,
    actionId: string,
    signal: AbortSignal,
    invocationCurrent: () => boolean,
  ) => Promise<void>;
  readonly subscriptions: ReadonlyArray<(publish: () => void) => () => void>;
  readonly starting?: () => number;
  readonly onAvailability?: (available: boolean, current: () => boolean) => void;
}

export function registerRevisionedActivityProvider(
  events: ActivityEvents,
  options: RevisionedActivityProviderOptions,
): () => void {
  let live = true;
  let availabilityGeneration = 0;
  const current = () => live && options.isCurrent();
  const lookup = (id: string, revision: string, signal: AbortSignal) => {
    if (!current() || signal.aborted) throw new Error("Activity provider is unavailable.");
    const item = Option.getOrUndefined(
      Arr.findFirst(
        options.items(),
        (candidate) => candidate.id === id && candidate.revision === revision,
      ),
    );
    if (!item) throw new Error("Activity item changed.");
    return item;
  };
  const { starting, onAvailability } = options;
  const registration = registerActivityProvider(events, {
    sessionId: options.sessionId,
    providerId: options.providerId,
    snapshot: () => (current() ? options.items() : []),
    ...(starting && { starting: () => (current() ? starting() : 0) }),
    getDetail: (id, revision, signal) =>
      Promise.resolve().then(() => options.detail(lookup(id, revision, signal))),
    invoke: (id, action, revision, signal) => {
      const generation = availabilityGeneration;
      const invocationCurrent = () =>
        current() &&
        !signal.aborted &&
        registration.isAvailable() &&
        generation === availabilityGeneration;
      return Promise.resolve().then(() => {
        if (!invocationCurrent()) throw new Error("Activity provider is unavailable.");
        const item = lookup(id, revision, signal);
        if (!item.actions || !Arr.some(item.actions, (allowed) => allowed.id === action))
          throw new Error("Activity action is unavailable.");
        return options.act(item, action, signal, invocationCurrent);
      });
    },
    onAvailability: (available: boolean) => {
      availabilityGeneration++;
      onAvailability?.(available, current);
    },
  });
  const unsubscribes = Arr.map(options.subscriptions, (subscribe) =>
    subscribe(() => registration.publish()),
  );
  registration.publish();
  return () => {
    live = false;
    for (const unsubscribe of unsubscribes) unsubscribe();
    registration.dispose();
  };
}
