import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { detachActivityItem } from "./detach.ts";

export const ACTIVITY_VERSION = 1 as const;
export const ACTIVITY_EVENT = "cosmic-ui:activity:v1";
export const ACTIVITY_DISCOVER = "cosmic-ui:activity:discover:v1";
export const ACTIVITY_HOST = "cosmic-ui:activity:host:v1";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Timestamp = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PhaseTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160));
const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000),
);
export const ActivityPhaseSchema = Schema.Struct({
  title: PhaseTitle,
  detail: Schema.optional(Text),
  /**
   * The producer's own count of the phase's work, including members it no longer publishes or
   * the host no longer retains. When present, the phase state comes from it, not visible members.
   */
  work: Schema.optional(Schema.Struct({ items: Count, finished: Count, stopped: Count })),
  /**
   * The producer's own count of planned members in this phase that never started, including
   * planned rows it does not publish. When present, phase rows show it instead of visible rows.
   */
  planned: Schema.optional(Count),
});
export type ActivityPhase = typeof ActivityPhaseSchema.Type;
export const ActivityStartingSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(16384),
);
const ActivityFields = {
  id: Id,
  kind: Schema.Literals(["agent", "command", "question", "workflow"]),
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
  /** Workflow items only: ordered display phases, at most 32. */
  phases: Schema.optional(Schema.Array(ActivityPhaseSchema).check(Schema.isMaxLength(32))),
  /** A workflow's current phase, or the phase a direct workflow member belongs to. */
  phase: Schema.optional(PhaseTitle),
  /**
   * Workflow items only: the producer's own count of planned members outside its published
   * `phases`, such as those in phases past the 32 shown, including rows it does not publish. When
   * present, it replaces the count of visible planned rows directly under the workflow.
   */
  unphasedPlanned: Schema.optional(Count),
  /**
   * Display-only: work its producer declared but has not started, such as a workflow agent its
   * script has not called yet. Planned items are never workflows and offer no actions; they are
   * `pending` while their owner may still start them and `cancelled` once it never will.
   */
  planned: Schema.optional(Schema.Boolean),
  actions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Id,
        label: Text,
        confirmation: Schema.optional(Text),
        /**
         * Whether the producer opens its own UI for this action, so the manager closes first.
         * Defaults to true; only `false` actions, which open no UI, run with the manager open.
         */
        handoff: Schema.optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(16)),
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
const callback = <F>() =>
  Schema.optional(Schema.declare<F>((value): value is F => Predicate.isFunction(value)));
export const ActivityEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  providerId: Id,
  operation: Schema.Literals(["register", "publish", "revoke"]),
  token: Schema.ObjectKeyword,
  hostToken: Schema.ObjectKeyword,
  items: Schema.optional(Schema.Unknown),
  starting: Schema.optional(Schema.Unknown),
  invoke: callback<ActivityProviderOptions["invoke"]>(),
  getDetail: callback<NonNullable<ActivityProviderOptions["getDetail"]>>(),
  acknowledge: callback<(available: boolean) => void>(),
});
export type ActivityEnvelope = typeof ActivityEnvelopeSchema.Type;
export const ActivityHostSchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Id,
  hostToken: Schema.ObjectKeyword,
  available: Schema.Boolean,
});

const safeSummary = (text: string, limit: number) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(text.slice(0, limit)), { maximumLength: limit });
const detachedSummaries = (items: readonly ActivityItem[]): readonly ActivityItem[] | undefined => {
  if (
    items.length > 512 ||
    items.some((item) => (item.actions?.length ?? 0) > 16 || (item.phases?.length ?? 0) > 32)
  )
    return undefined;
  return items.map((item) =>
    detachActivityItem(item, safeSummary, (detail) =>
      sanitizeDiagnosticContent(detail.slice(0, 16384), { maximumLength: 16384 }),
    ),
  );
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

export interface RevisionedActivityProviderOptions {
  readonly sessionId: string;
  readonly providerId: string;
  readonly isCurrent: () => boolean;
  readonly items: () => readonly ActivityItem[];
  /** Detail for an item that passed the session and exact-revision checks. */
  readonly detail: (item: ActivityItem) => string;
  /** Recheck invocationCurrent after user input or another yield before changing source state. */
  readonly act: (
    item: ActivityItem,
    actionId: string,
    signal: AbortSignal,
    invocationCurrent: () => boolean,
  ) => Promise<void>;
  /** Change sources that republish the snapshot; each returns its unsubscribe. */
  readonly subscriptions: ReadonlyArray<(publish: () => void) => () => void>;
  readonly starting?: () => number;
  readonly onAvailability?: (available: boolean, current: () => boolean) => void;
}

/**
 * Registers a provider whose detail and actions require the current session and the exact item
 * revision, and whose actions must be offered by that revision. Returns the disposer.
 */
export function registerRevisionedActivityProvider(
  events: ActivityEvents,
  options: RevisionedActivityProviderOptions,
): () => void {
  let live = true;
  let availabilityGeneration = 0;
  const current = () => live && options.isCurrent();
  const lookup = (id: string, revision: string, signal: AbortSignal) => {
    if (!current() || signal.aborted) throw new Error("Activity provider is unavailable.");
    const item = options.items().find((item) => item.id === id && item.revision === revision);
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
        if (!item.actions?.some((allowed) => allowed.id === action))
          throw new Error("Activity action is unavailable.");
        return options.act(item, action, signal, invocationCurrent);
      });
    },
    onAvailability: (available: boolean) => {
      availabilityGeneration++;
      onAvailability?.(available, current);
    },
  });
  const unsubscribes = options.subscriptions.map((subscribe) =>
    subscribe(() => registration.publish()),
  );
  registration.publish();
  return () => {
    live = false;
    for (const unsubscribe of unsubscribes) unsubscribe();
    registration.dispose();
  };
}
