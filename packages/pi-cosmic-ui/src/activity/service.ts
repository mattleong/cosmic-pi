import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  decodeUnknownOrUndefined,
  makeFrozenProjection,
  sanitizeTerminalLine,
  sanitizeDiagnosticContent,
} from "pi-cosmic-core";
import {
  ActivitySnapshotSchema,
  ActivityStartingSchema,
  activityKey,
  type ActivityEnvelope,
  type ActivityItem,
  type ActivityPhase,
  type ActivityProviderOptions,
} from "./protocol.ts";
import { retainActivity, type ActivityRow } from "./model.ts";
import { detachActivityItem } from "./detach.ts";
import { ACTIVITY_LIMITS } from "./limits.ts";
import { SPINNER_FRAME_MS } from "../manager/chrome.ts";

export class ActivityError extends Schema.TaggedError<ActivityError>()("ActivityError", {
  reason: Schema.Literals(["invalid", "stale", "failed"]),
}) {}
interface Provider {
  readonly token: object;
  readonly generation: number;
  readonly invoke: ActivityProviderOptions["invoke"];
  readonly getDetail?: ActivityProviderOptions["getDetail"];
  readonly acknowledge: (available: boolean) => void;
  readonly items: readonly ActivityRow[];
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
  /** Runs after each committed change; may request followed details. */
  readonly changed?: () => void;
  readonly tick?: (now: number) => void;
  readonly connect?: (service: ActivityServiceContract) => () => void;
}
const invalid = () => new ActivityError({ reason: "invalid" });
const stale = () => new ActivityError({ reason: "stale" });
const failed = () => new ActivityError({ reason: "failed" });
/** Keeps a typed failure, such as a stale recheck, and contains anything else. */
const asActivityError = (cause: unknown) => (cause instanceof ActivityError ? cause : failed());
/** Host and producer callbacks are best effort: a throw is contained and ignored. */
const bestEffort = (run: () => void) => Effect.try({ try: run, catch: failed }).pipe(Effect.ignore);
const cleanDetail = (text: string) =>
  sanitizeDiagnosticContent(
    text.slice(0, ACTIVITY_LIMITS.detail).split("\n").map(sanitizeTerminalLine).join("\n"),
    { maximumLength: ACTIVITY_LIMITS.detail },
  );
type Acknowledgement = readonly [Provider, boolean];
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;
/** Stopped, failed and skipped work are disjoint parts of the finished work. */
const consistentWork = ({ work }: ActivityPhase) =>
  !work ||
  (work.finished <= work.items &&
    work.stopped + (work.failed ?? 0) + (work.skipped ?? 0) <= work.finished);
/** Workflow phases describe the workflow row; attention rolls up from its members only. */
const consistentWorkflow = (item: ActivityItem) => {
  if (item.kind !== "workflow")
    return item.phases === undefined && item.unphasedPlanned === undefined;
  const titles = item.phases?.map((phase) => phase.title) ?? [];
  return (
    uniqueIds(titles) &&
    (item.phases ?? []).every(consistentWork) &&
    (item.phase === undefined || titles.includes(item.phase)) &&
    item.status !== "needs-input" &&
    item.status !== "blocked"
  );
};
/**
 * Planned work is never a workflow and never under way. Only planned work its owner may still
 * start offers actions, such as skipping it; once it never will, it offers none.
 */
const consistentPlan = (item: ActivityItem) =>
  item.planned !== true ||
  (item.kind !== "workflow" &&
    (item.status === "pending" || (item.status === "cancelled" && !item.actions?.length)));
/** Only cancelled work, never planned, a workflow or a question, is skipped. */
const consistentSkip = (item: ActivityItem) =>
  item.skipped !== true ||
  (item.status === "cancelled" &&
    item.planned !== true &&
    item.kind !== "workflow" &&
    item.kind !== "question");
/** Runs on cleaned items so titles that collide after sanitizing are rejected too. */
const consistentSnapshot = (items: readonly ActivityItem[]) =>
  uniqueIds(items.map((item) => item.id)) &&
  items.every(
    (item) =>
      uniqueIds(item.actions?.map((action) => action.id) ?? []) &&
      consistentWorkflow(item) &&
      consistentPlan(item) &&
      consistentSkip(item),
  );
/** Work waiting to start; planned items are declarations, not launches. */
const startingWork = (item: ActivityItem) =>
  item.kind === "agent" && item.status === "pending" && item.planned !== true;
/** The current provider's row a request names, at its exact generation and revision. */
const currentRow = (rows: readonly ActivityRow[], request: ActivityDetailRequest) =>
  rows.find(
    (row) =>
      row.key === request.key &&
      !row.retained &&
      row.generation === request.generation &&
      row.revision === request.revision,
  );
export class ActivityService extends Context.Service<ActivityService, ActivityServiceContract>()(
  "pi-cosmic-ui/activity/service/ActivityService",
) {
  static make = Effect.fn("ActivityService.make")(function* (options: ActivityServiceOptions) {
    const state = yield* makeFrozenProjection<State, ActivityViewSnapshot>(
      { closed: false, serial: 0, providers: new Map(), retired: new Set(), rows: [] },
      (value) => ({
        rows: value.rows,
        starting: [...value.providers.values()].reduce(
          (count, provider) =>
            count + (provider.starting || provider.items.filter(startingWork).length),
          0,
        ),
      }),
      (view) => options.publish(view.rows, view.starting),
    ).pipe(Effect.mapError(failed));
    const changed = bestEffort(() => options.changed?.());
    /** An invalid snapshot withdraws its provider's rows, starting count and availability. */
    const withdraw = (event: ActivityEnvelope) =>
      state
        .transition((old) => {
          const provider = old.providers.get(event.providerId);
          if (provider?.token !== event.token)
            return Effect.succeed([event.acknowledge, old] as const);
          const providers = new Map(old.providers).set(event.providerId, {
            ...provider,
            items: [],
            starting: 0,
          });
          return Effect.succeed([
            provider.acknowledge,
            {
              ...old,
              providers,
              rows: old.rows.filter((row) => row.providerId !== event.providerId),
            },
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
        const notices = yield* state
          .transition<readonly Acknowledgement[], ActivityError, never>((old) =>
            Effect.gen(function* () {
              const unchanged = [[], old] as const;
              if (old.closed || old.retired.has(event.token)) return unchanged;
              const current = old.providers.get(event.providerId);
              if (event.operation !== "register" && current?.token !== event.token)
                return unchanged;
              if (event.operation === "revoke") {
                const providers = new Map(old.providers);
                providers.delete(event.providerId);
                const retired = new Set(old.retired).add(event.token);
                const acknowledgements: Acknowledgement[] = current ? [[current, false]] : [];
                return [
                  acknowledgements,
                  {
                    ...old,
                    providers,
                    retired,
                    rows: old.rows.filter((row) => row.providerId !== event.providerId),
                  },
                ] as const;
              }
              // Lock waiting stays interruptible; core owns only the narrow projection commit.
              // Hostile proxies and throwing getters are invalid like any other malformed input.
              const decoded = decodeUnknownOrUndefined(ActivitySnapshotSchema, event.items);
              const starting = decodeUnknownOrUndefined(
                ActivityStartingSchema,
                event.starting === undefined ? 0 : event.starting,
              );
              if (decoded === undefined || starting === undefined) return yield* invalid();
              const cleaned = decoded.map((item) => detachActivityItem(item, cleanDetail));
              if (!consistentSnapshot(cleaned)) return yield* invalid();
              // Only a registration reaches here with a new token.
              const isNew = current?.token !== event.token;
              if (
                isNew &&
                (!event.invoke ||
                  !event.acknowledge ||
                  old.providers.size >= 32 ||
                  old.serial >= 4096)
              )
                return unchanged;
              const generation = isNew ? old.serial + 1 : current!.generation;
              const items: readonly ActivityRow[] = cleaned.map((item) => ({
                ...item,
                actions: item.actions ?? [],
                key: activityKey(event.providerId, item.id),
                providerId: event.providerId,
                generation,
              }));
              const provider: Provider = isNew
                ? {
                    token: event.token,
                    generation,
                    items,
                    starting,
                    invoke: event.invoke!,
                    acknowledge: event.acknowledge!,
                    ...(event.getDetail && { getDetail: event.getDetail }),
                  }
                : { ...current!, items, starting };
              const providers = new Map(old.providers).set(event.providerId, provider);
              const retired = new Set(old.retired);
              const acknowledgements: Acknowledgement[] = [];
              if (isNew && current) {
                retired.add(current.token);
                acknowledgements.push([current, false]);
              }
              acknowledgements.push([provider, true]);
              const live = [...providers.values()].flatMap((entry) => entry.items);
              return [
                acknowledgements,
                {
                  ...old,
                  serial: Math.max(old.serial, generation),
                  providers,
                  retired,
                  rows: retainActivity(old.rows, live),
                },
              ] as const;
            }),
          )
          .pipe(Effect.mapError(asActivityError));
        for (const [provider, available] of notices) {
          // A provider replaced meanwhile is never told it is available.
          if (available && (yield* state.getState).providers.get(event.providerId) !== provider)
            continue;
          yield* bestEffort(() => provider.acknowledge(available));
        }
        yield* changed;
      },
      (effect, event) =>
        effect.pipe(
          Effect.tapError((error) => (error.reason === "invalid" ? withdraw(event) : Effect.void)),
        ),
    );
    /** Rechecks the frozen current projection immediately before a captured capability runs. */
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
          if (!checkedRow(request).actions?.some((action) => action.id === request.actionId))
            throw stale();
          return provider.invoke(row.id, request.actionId, request.revision, signal);
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
          return getDetail(row.id, request.revision, signal);
        },
        catch: asActivityError,
      });
      // Producers are untrusted, so their detail may not be text at all.
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
                rows.some(
                  (row) =>
                    row.status === "running" || (row.status === "pending" && row.planned !== true),
                )
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
