import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";

export const ACTIVITY_VERSION = 1 as const;
export const ACTIVITY_EVENT = "cosmic-ui:activity:v1";
export const ACTIVITY_DISCOVER = "cosmic-ui:activity:discover:v1";
export const ACTIVITY_HOST = "cosmic-ui:activity:host:v1";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export const ActivityStartingSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(16384),
);
const ActivityFields = {
  id: Id,
  kind: Schema.Literals(["agent", "command", "question"]),
  title: Schema.String.check(Schema.isMaxLength(512)),
  profile: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  route: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  awaited: Schema.optional(Schema.Boolean),
  revision: Id,
  startedAt: Schema.optional(Timestamp),
  endedAt: Schema.optional(Timestamp),
  updatedAt: Schema.optional(Timestamp),
  parent: Schema.optional(Schema.Struct({ providerId: Id, itemId: Id })),
  summary: Schema.optional(Text),
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
  actions: Schema.optional(
    Schema.Array(Schema.Struct({ id: Id, label: Text, confirmation: Schema.optional(Text) })).check(
      Schema.isMaxLength(16),
    ),
  ),
};
export const ActivityItemSchema = Schema.Union([
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
  Schema.isMaxLength(512),
);
export const activityKey = (providerId: string, itemId: string): string =>
  JSON.stringify([providerId, itemId]);

export type ActivityEvents = Pick<ExtensionAPI["events"], "on" | "emit">;
export interface ActivityProviderOptions {
  readonly sessionId: string;
  readonly providerId: string;
  readonly snapshot: () => readonly ActivityItem[];
  /** Active launch requests, including the interval before run rows exist. */
  readonly starting?: () => number;
  /** Recheck session, revision, ownership and allowed action immediately before operating. */
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
export interface ActivityEnvelope {
  readonly version: 1;
  readonly sessionId: string;
  readonly providerId: string;
  readonly token: object;
  readonly hostToken: object;
  readonly operation: "register" | "publish" | "revoke";
  readonly items?: unknown;
  readonly starting?: unknown;
  readonly invoke?: ActivityProviderOptions["invoke"];
  readonly getDetail?: ActivityProviderOptions["getDetail"];
  readonly acknowledge?: (available: boolean) => void;
}
export const ActivityHostSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Id,
  hostToken: Schema.ObjectKeyword,
  available: Schema.Boolean,
});

const safeSummary = (text: string, limit: number) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(text.slice(0, limit)), { maximumLength: limit });
const detachedSummaries = (items: readonly ActivityItem[]): readonly ActivityItem[] | undefined => {
  if (items.length > 512 || items.some((item) => (item.actions?.length ?? 0) > 16))
    return undefined;
  return items.map((item) => {
    const detached = { ...item, title: safeSummary(item.title, 512) };
    if (item.parent) Object.assign(detached, { parent: { ...item.parent } });
    if (item.profile !== undefined)
      Object.assign(detached, { profile: safeSummary(item.profile, 80) });
    if (item.route !== undefined) Object.assign(detached, { route: safeSummary(item.route, 512) });
    if (item.summary !== undefined)
      Object.assign(detached, { summary: safeSummary(item.summary, 4096) });
    if (item.detail !== undefined)
      Object.assign(detached, {
        detail: sanitizeDiagnosticContent(item.detail.slice(0, 16384), { maximumLength: 16384 }),
      });
    if (item.actions)
      Object.assign(detached, {
        actions: item.actions.map((action) => {
          const value = { ...action, label: safeSummary(action.label, 4096) };
          if (action.confirmation !== undefined)
            Object.assign(value, { confirmation: safeSummary(action.confirmation, 4096) });
          return value;
        }),
      });
    return detached;
  });
};

/** Plain callback adapter. Its owner must dispose it when the producer session closes. */
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
    } catch {
      /* Producer presentation is best effort. */
    }
  };
  const send = (operation: ActivityEnvelope["operation"]) => {
    if (disposed || !hostToken) return;
    const registrationHost = hostToken;
    try {
      const envelope: ActivityEnvelope = {
        version: ACTIVITY_VERSION,
        sessionId: options.sessionId,
        providerId: options.providerId,
        token,
        hostToken: registrationHost,
        operation,
      };
      if (operation !== "revoke")
        Object.assign(envelope, {
          items: detachedSummaries(options.snapshot()),
          starting: options.starting?.() ?? 0,
        });
      if (operation === "register")
        Object.assign(envelope, {
          invoke: (itemId: string, actionId: string, revision: string, signal: AbortSignal) => {
            if (disposed || !available || hostToken !== registrationHost || signal.aborted)
              return Promise.reject(new Error("Activity provider unavailable."));
            return options.invoke(itemId, actionId, revision, signal);
          },
          acknowledge: (next: boolean) => {
            if (hostToken === registrationHost) acknowledge(next);
          },
        });
      const getDetail = options.getDetail;
      if (operation === "register" && getDetail)
        Object.assign(envelope, {
          getDetail: (itemId: string, revision: string, signal: AbortSignal) => {
            if (disposed || !available || hostToken !== registrationHost || signal.aborted)
              return Promise.reject(new Error("Activity provider unavailable."));
            return getDetail(itemId, revision, signal);
          },
        });
      events.emit(ACTIVITY_EVENT, envelope);
    } catch {
      acknowledge(false);
    }
  };
  const unsubscribe = events.on(ACTIVITY_HOST, (data) => {
    try {
      if (!Schema.is(ActivityHostSchema)(data) || data.sessionId !== options.sessionId) return;
      if (data.available) {
        if (hostToken !== data.hostToken) acknowledge(false);
        hostToken = data.hostToken;
        send("register");
      } else if (hostToken === data.hostToken) acknowledge(false);
    } catch {
      /* Malformed host announcements cannot change provider ownership. */
    }
  });
  try {
    events.emit(ACTIVITY_DISCOVER, { version: ACTIVITY_VERSION, sessionId: options.sessionId });
  } catch {
    /* Missing host leaves fallback active. */
  }
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
