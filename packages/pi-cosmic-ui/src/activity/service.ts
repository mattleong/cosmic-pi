import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  decodeUnknownOrUndefined,
  freezeSnapshot,
  frozenProjection,
  invokeBestEffort,
  sanitizeTerminalLine,
  sanitizeDiagnosticContent,
} from "pi-cosmic-core";
import {
  ActivitySnapshotSchema,
  ActivityStartingSchema,
  activityKey,
  type ActivityEnvelope,
  type ActivityItem,
} from "./protocol.ts";
import { retainActivity, type ActivityRow } from "./model.ts";
import { detachActivityItem } from "./detach.ts";
import { ACTIVITY_LIMITS } from "./limits.ts";
import { SPINNER_FRAME_MS } from "../manager/chrome.ts";

export class ActivityError extends Schema.TaggedError<
  ActivityError,
  { readonly brand: unique symbol }
>()("ActivityError", {
  reason: Schema.Literals(["invalid", "stale", "failed"]),
}) {}
interface Provider {
  readonly token: object;
  readonly generation: number;
  readonly invoke: NonNullable<ActivityEnvelope["invoke"]>;
  readonly getDetail?: ActivityEnvelope["getDetail"];
  readonly acknowledge: NonNullable<ActivityEnvelope["acknowledge"]>;
  readonly items: readonly ActivityRow[];
  /** The decoded items `items` were cleaned from, in the same order. */
  readonly sources: readonly ActivityItem[];
  readonly starting: number;
}
interface State {
  readonly closed: boolean;
  readonly serial: number;
  readonly providers: ReadonlyMap<string, Provider>;
  readonly retired: ReadonlySet<object>;
  readonly rows: readonly ActivityRow[];
}
export interface ActivityDetailRequest {
  readonly key: string;
  readonly generation: number;
  readonly revision: string;
}
export interface ActivityActionRequest extends ActivityDetailRequest {
  readonly actionId: string;
}
export interface ActivityServiceContract {
  readonly receive: (event: ActivityEnvelope) => Effect.Effect<void, ActivityError>;
  readonly invoke: (request: ActivityActionRequest) => Effect.Effect<void, ActivityError>;
  readonly detail: (request: ActivityDetailRequest) => Effect.Effect<string, ActivityError>;
}
interface ActivityViewSnapshot {
  readonly rows: readonly ActivityRow[];
  readonly starting: number;
}
export interface ActivityServiceOptions {
  readonly publish: (rows: readonly ActivityRow[], starting: number) => void;
  readonly changed?: () => void;
  readonly tick?: (now: number) => void;
  readonly connect?: (service: ActivityServiceContract) => () => void;
}
const invalid = () => ActivityError.make({ reason: "invalid" });
const stale = () => ActivityError.make({ reason: "stale" });
const failed = () => ActivityError.make({ reason: "failed" });
const isActivityError = Schema.is(ActivityError);
const asActivityError = (cause: unknown) => (isActivityError(cause) ? cause : failed());
// Foreign callbacks may throw or return a rejected thenable; both are contained.
const bestEffort = (run: () => void) => Effect.sync(() => invokeBestEffort(run));
const cleanDetail = (text: string) =>
  sanitizeDiagnosticContent(
    Arr.join(
      Arr.map(
        Str.split(Fn.pipe(text, Str.slice(0, ACTIVITY_LIMITS.detail)), "\n"),
        sanitizeTerminalLine,
      ),
      "\n",
    ),
    { maximumLength: ACTIVITY_LIMITS.detail },
  );
type Acknowledgement = readonly [Provider, boolean];
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;
const consistentSnapshot = (items: readonly ActivityItem[]) =>
  uniqueIds(Arr.map(items, (item) => item.id)) &&
  Arr.every(items, (item) => uniqueIds(Arr.map(item.actions ?? [], (action) => action.id)));
type Transition = readonly [readonly Acknowledgement[], State];
type ProviderIdentity = Omit<Provider, "items" | "sources" | "starting">;
interface DecodedSnapshot {
  readonly items: readonly ActivityItem[];
  readonly starting: number;
}
const withoutProviderRows = (rows: readonly ActivityRow[], providerId: string) =>
  Arr.filter(rows, (row) => row.providerId !== providerId);
const revokeProvider = (
  old: State,
  event: ActivityEnvelope,
  current: Provider | undefined,
): Transition => {
  const providers = new Map(old.providers);
  providers.delete(event.providerId);
  return [
    current ? [[current, false]] : [],
    {
      ...old,
      providers,
      retired: new Set(old.retired).add(event.token),
      rows: withoutProviderRows(old.rows, event.providerId),
    },
  ];
};
const decodeSnapshotItems = decodeUnknownOrUndefined(ActivitySnapshotSchema);
const decodeStarting = decodeUnknownOrUndefined(ActivityStartingSchema);
const decodeSnapshot = (event: ActivityEnvelope): DecodedSnapshot | undefined => {
  const items = decodeSnapshotItems(event.items);
  const starting = decodeStarting(event.starting === undefined ? 0 : event.starting);
  if (items === undefined || starting === undefined) return undefined;
  return consistentSnapshot(items) ? { items, starting } : undefined;
};
type ActivityAction = NonNullable<ActivityItem["actions"]>[number];
// Each `satisfies` fails to compile when the protocol gains a field, so comparison covers it.
const ITEM_FIELDS = {
  id: true,
  kind: true,
  title: true,
  profile: true,
  route: true,
  awaited: true,
  revision: true,
  startedAt: true,
  endedAt: true,
  updatedAt: true,
  summary: true,
  detail: true,
  status: true,
  inputTarget: true,
  blockedReason: true,
  parent: false,
  actions: false,
} as const satisfies Record<keyof ActivityItem, boolean>;
const ITEM_VALUE_FIELDS = Arr.filter(Rec.keys(ITEM_FIELDS), (key) => ITEM_FIELDS[key]);
const ACTION_FIELDS = Rec.keys({
  id: true,
  label: true,
  confirmation: true,
  handoff: true,
} as const satisfies Record<keyof ActivityAction, true>);
const sameActions = (left: ActivityItem["actions"], right: ActivityItem["actions"]) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    Arr.every(left, (action, index) => {
      const other = right[index];
      return other !== undefined && Arr.every(ACTION_FIELDS, (key) => action[key] === other[key]);
    }));
/** Compares decoded items field by field; an absent field equals an explicit `undefined`. */
const sameItem = (left: ActivityItem, right: ActivityItem) =>
  Arr.every(ITEM_VALUE_FIELDS, (key) => left[key] === right[key]) &&
  left.parent?.providerId === right.parent?.providerId &&
  left.parent?.itemId === right.parent?.itemId &&
  sameActions(left.actions, right.actions);
// Item revisions are producer claims; content decides whether a republish changes anything.
const sameSnapshot = (provider: Provider, snapshot: DecodedSnapshot) =>
  provider.starting === snapshot.starting &&
  provider.sources.length === snapshot.items.length &&
  Arr.every(snapshot.items, (item, index) => {
    const source = provider.sources[index];
    return source !== undefined && sameItem(item, source);
  });
/**
 * Cleans each item into a frozen row. An item equal to the one its provider last published keeps
 * that row, so it is not sanitized again and publications can share it by reference.
 */
const cleanedRows = (
  providerId: string,
  generation: number,
  items: readonly ActivityItem[],
  previous: Provider | undefined,
): readonly ActivityRow[] => {
  const cleaned = new Map(
    Arr.map(
      Arr.zip(previous?.sources ?? [], previous?.items ?? []),
      ([source, row]) => [source.id, { source, row }] as const,
    ),
  );
  return Arr.map(items, (item) => {
    const prior = cleaned.get(item.id);
    if (prior && sameItem(item, prior.source))
      return prior.row.generation === generation
        ? prior.row
        : freezeSnapshot({ ...prior.row, generation });
    const detached = detachActivityItem(item, cleanDetail);
    return freezeSnapshot({
      ...detached,
      actions: detached.actions ?? [],
      key: activityKey(providerId, item.id),
      providerId,
      generation,
    });
  });
};
const registeredProvider = (old: State, event: ActivityEnvelope): ProviderIdentity | undefined => {
  const { invoke, acknowledge, getDetail } = event;
  if (
    !invoke ||
    !acknowledge ||
    (old.providers.size >= 32 && !old.providers.has(event.providerId)) ||
    old.serial >= 4096
  )
    return undefined;
  return {
    token: event.token,
    generation: old.serial + 1,
    invoke,
    acknowledge,
    ...(getDetail && { getDetail }),
  };
};
const publishSnapshot = (
  old: State,
  event: ActivityEnvelope,
  current: Provider | undefined,
  snapshot: DecodedSnapshot,
): Transition | undefined => {
  // An identical republish keeps the accepted state, and with it the published snapshot.
  if (current?.token === event.token && sameSnapshot(current, snapshot))
    return [[[current, true]], old];
  const isNew = current?.token !== event.token;
  const identity = isNew ? registeredProvider(old, event) : current;
  if (!identity) return undefined;
  const provider: Provider = {
    ...identity,
    items: cleanedRows(event.providerId, identity.generation, snapshot.items, current),
    sources: snapshot.items,
    starting: snapshot.starting,
  };
  const providers = new Map(old.providers).set(event.providerId, provider);
  const retired = new Set(old.retired);
  const acknowledgements: Acknowledgement[] = [];
  if (isNew && current) {
    retired.add(current.token);
    acknowledgements.push([current, false]);
  }
  acknowledgements.push([provider, true]);
  const live = Arr.flatMap([...providers.values()], (entry) => entry.items);
  return [
    acknowledgements,
    {
      ...old,
      serial: Math.max(old.serial, identity.generation),
      providers,
      retired,
      // Frozen rows let each publication reuse unchanged rows instead of copying them.
      rows: Arr.map(retainActivity(old.rows, live), freezeSnapshot),
    },
  ];
};
const admit = Effect.fnUntraced(function* (old: State, event: ActivityEnvelope) {
  const unchanged: Transition = [[], old];
  if (old.closed || old.retired.has(event.token)) return unchanged;
  const current = old.providers.get(event.providerId);
  if (event.operation !== "register" && current?.token !== event.token) return unchanged;
  if (event.operation === "revoke") return revokeProvider(old, event, current);
  const snapshot = decodeSnapshot(event);
  if (!snapshot) return yield* invalid();
  return publishSnapshot(old, event, current, snapshot) ?? unchanged;
});
const startingWork = (item: ActivityItem) => item.kind === "agent" && item.status === "pending";
const currentRow = (rows: readonly ActivityRow[], request: ActivityDetailRequest) =>
  Option.getOrUndefined(
    Arr.findFirst(
      rows,
      (row) =>
        row.key === request.key &&
        !row.retained &&
        row.generation === request.generation &&
        row.revision === request.revision,
    ),
  );
export class ActivityService extends Context.Service<ActivityService, ActivityServiceContract>()(
  "pi-cosmic-ui/activity/service/ActivityService",
) {
  static make = Effect.fn("ActivityService.make")(function* (options: ActivityServiceOptions) {
    const state = yield* frozenProjection<State, ActivityViewSnapshot>(
      { closed: false, serial: 0, providers: new Map(), retired: new Set(), rows: [] },
      (value) => ({
        rows: value.rows,
        starting: Arr.reduce(
          [...value.providers.values()],
          0,
          (count, provider) =>
            count + (provider.starting || Arr.filter(provider.items, startingWork).length),
        ),
      }),
      (view) => options.publish(view.rows, view.starting),
    ).pipe(Effect.mapError(failed));
    const changed = bestEffort(() => options.changed?.());
    const withdraw = (event: ActivityEnvelope) =>
      state
        .transition((old) => {
          const provider = old.providers.get(event.providerId);
          if (provider?.token !== event.token)
            return Effect.succeed([event.acknowledge, old] as const);
          const providers = new Map(old.providers).set(event.providerId, {
            ...provider,
            items: [],
            sources: [],
            starting: 0,
          });
          return Effect.succeed([
            provider.acknowledge,
            { ...old, providers, rows: withoutProviderRows(old.rows, event.providerId) },
          ] as const);
        })
        .pipe(
          Effect.tap(() => changed),
          Effect.flatMap((acknowledge) =>
            acknowledge ? bestEffort(() => acknowledge(false)) : Effect.void,
          ),
          Effect.ignore,
        );
    const receive = Effect.fn("ActivityService.receive")(
      function* (event: ActivityEnvelope) {
        const [notices, updated] = yield* state
          .transition<readonly [readonly Acknowledgement[], boolean], ActivityError, never>((old) =>
            Effect.gen(function* () {
              const [acknowledgements, next] = yield* admit(old, event);
              return [[acknowledgements, next !== old], next] as const;
            }),
          )
          .pipe(Effect.mapError(asActivityError));
        for (const [provider, available] of notices) {
          if (available && (yield* state.getState).providers.get(event.providerId) !== provider)
            continue;
          yield* bestEffort(() => provider.acknowledge(available));
        }
        if (updated) yield* changed;
      },
      (effect, event) =>
        effect.pipe(
          Effect.tapError((error) => (error.reason === "invalid" ? withdraw(event) : Effect.void)),
        ),
    );
    const checkedRow = (request: ActivityDetailRequest): ActivityRow => {
      const row = currentRow(state.getSnapshot().rows, request);
      if (!row) throw stale();
      return row;
    };
    const providerFor = (request: ActivityDetailRequest) =>
      Effect.flatMap(state.getState, (current) => {
        const row = currentRow(current.rows, request);
        const provider = row && current.providers.get(row.providerId);
        return row && provider ? Effect.succeed({ provider, row }) : Effect.fail(stale());
      });
    const invoke = Effect.fn("ActivityService.invoke")(function* (request: ActivityActionRequest) {
      const { provider, row } = yield* providerFor(request);
      yield* Effect.tryPromise({
        try: (signal) => {
          const actions = checkedRow(request).actions;
          if (!actions || !Arr.some(actions, (action) => action.id === request.actionId))
            throw stale();
          return Promise.resolve<unknown>(
            provider.invoke(row.id, request.actionId, request.revision, signal),
          );
        },
        catch: asActivityError,
      });
    });
    const detail = Effect.fn("ActivityService.detail")(function* (request: ActivityDetailRequest) {
      const { provider, row } = yield* providerFor(request);
      const getDetail = provider.getDetail;
      if (!getDetail) return row.detail ?? "";
      const text = yield* Effect.tryPromise({
        try: (signal) => {
          checkedRow(request);
          return Promise.resolve<unknown>(getDetail(row.id, request.revision, signal));
        },
        catch: asActivityError,
      });
      if (!Predicate.isString(text)) return yield* invalid();
      return yield* Effect.try({
        try: () => {
          checkedRow(request);
          return cleanDetail(text);
        },
        catch: asActivityError,
      });
    });
    yield* Effect.addFinalizer(() =>
      state
        .transition((old) =>
          Effect.gen(function* () {
            for (const provider of old.providers.values())
              yield* bestEffort(() => provider.acknowledge(false));
            return [
              undefined,
              { ...old, closed: true, providers: new Map(), retired: new Set(), rows: [] },
            ] as const;
          }),
        )
        .pipe(Effect.ignore),
    );
    const service = { receive, invoke, detail } satisfies ActivityServiceContract;
    const connect = options.connect;
    if (connect)
      yield* Effect.acquireRelease(
        Effect.try({ try: () => connect(service), catch: failed }),
        (release) => bestEffort(release),
      );
    const tick = options.tick;
    if (tick) {
      const updateClock = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        bestEffort(() => tick(now)),
      );
      yield* updateClock;
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.suspend(() => {
            const { rows, starting } = state.getSnapshot();
            return Effect.sleep(
              starting > 0 ||
                Arr.some(rows, (row) => row.status === "running" || row.status === "pending")
                ? `${SPINNER_FRAME_MS} millis`
                : "1 second",
            ).pipe(Effect.andThen(updateClock));
          }),
        ),
      );
    }
    return service;
  });
  static layer = (options: ActivityServiceOptions) =>
    Layer.effect(ActivityService, ActivityService.make(options));
}
