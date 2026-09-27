import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  makeFrozenProjection,
  sanitizeTerminalLine,
  sanitizeDiagnosticContent,
} from "pi-cosmic-core";
import {
  ActivitySnapshotSchema,
  ActivityStartingSchema,
  activityKey,
  type ActivityEnvelope,
  type ActivityProviderOptions,
} from "./protocol.ts";
import { retainActivity, type ActivityRow } from "./model.ts";
import { detachActivityItem } from "./detach.ts";
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
  readonly snapshot: Effect.Effect<readonly ActivityRow[]>;
}
interface ActivityViewSnapshot {
  readonly rows: readonly ActivityRow[];
  readonly starting: number;
}
export interface ActivityServiceOptions {
  readonly publish: (rows: readonly ActivityRow[], starting: number) => void;
  readonly tick?: (now: number) => void;
  readonly connect?: (service: ActivityServiceContract) => () => void;
}
const failed = () => new ActivityError({ reason: "failed" });
const callback = (run: () => void) => Effect.try({ try: run, catch: failed });
const cleanText = (text: string) =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(text), { maximumLength: 4096 });
const cleanDetail = (text: string) =>
  sanitizeDiagnosticContent(text.slice(0, 16384).split("\n").map(sanitizeTerminalLine).join("\n"), {
    maximumLength: 16384,
  });
type Acknowledgement = readonly [Provider, boolean];
export class ActivityService extends Context.Service<ActivityService, ActivityServiceContract>()(
  "pi-cosmic-ui/activity/service/ActivityService",
) {
  static make = (options: ActivityServiceOptions) =>
    Effect.gen(function* () {
      const state = yield* makeFrozenProjection<State, ActivityViewSnapshot>(
        { closed: false, serial: 0, providers: new Map(), retired: new Set(), rows: [] },
        (value) => ({
          rows: value.rows,
          starting: [...value.providers.values()].reduce(
            (count, provider) =>
              count +
              (provider.starting ||
                provider.items.filter((item) => item.kind === "agent" && item.status === "pending")
                  .length),
            0,
          ),
        }),
        (view) => options.publish(view.rows, view.starting),
      ).pipe(Effect.mapError(failed));
      const receive = (event: ActivityEnvelope) =>
        Effect.gen(function* () {
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
                // Decoding and lock waiting stay interruptible. Core owns only the narrow projection commit.
                const decoded = yield* Schema.decodeUnknownEffect(ActivitySnapshotSchema)(
                  event.items,
                ).pipe(Effect.mapError(() => new ActivityError({ reason: "invalid" })));
                const starting = yield* Schema.decodeUnknownEffect(ActivityStartingSchema)(
                  event.starting === undefined ? 0 : event.starting,
                ).pipe(Effect.mapError(() => new ActivityError({ reason: "invalid" })));
                if (
                  new Set(decoded.map((item) => item.id)).size !== decoded.length ||
                  decoded.some(
                    (item) =>
                      new Set(item.actions?.map((action) => action.id)).size !==
                      (item.actions?.length ?? 0),
                  )
                )
                  return yield* new ActivityError({ reason: "invalid" });
                const isNew = current?.token !== event.token;
                if (
                  isNew &&
                  (event.operation !== "register" ||
                    !event.invoke ||
                    !event.acknowledge ||
                    old.providers.size >= 32 ||
                    old.serial >= 4096)
                )
                  return unchanged;
                const generation = isNew ? old.serial + 1 : current!.generation;
                const items: readonly ActivityRow[] = decoded.map((item) => {
                  const detached = detachActivityItem(item, cleanText, cleanDetail);
                  return {
                    ...detached,
                    actions: detached.actions ?? [],
                    key: activityKey(event.providerId, item.id),
                    providerId: event.providerId,
                    generation,
                  };
                });
                const provider: Provider = isNew
                  ? {
                      token: event.token,
                      generation,
                      items,
                      starting,
                      invoke: event.invoke!,
                      acknowledge: event.acknowledge!,
                    }
                  : { ...current!, items, starting };
                if (isNew && event.getDetail)
                  Object.assign(provider, { getDetail: event.getDetail });
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
            .pipe(Effect.mapError((error) => (error instanceof ActivityError ? error : failed())));
          for (const [provider, available] of notices) {
            const current = yield* state.getState;
            if (available && ![...current.providers.values()].some((entry) => entry === provider))
              continue;
            yield* callback(() => provider.acknowledge(available)).pipe(Effect.ignore);
          }
        }).pipe(
          Effect.tapError((error) => {
            if (error.reason !== "invalid") return Effect.void;
            return state
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
                Effect.flatMap((acknowledge) =>
                  acknowledge ? callback(() => acknowledge(false)) : Effect.void,
                ),
                Effect.ignore,
              );
          }),
        );
      const checkedRow = (request: ActivityDetailRequest): ActivityRow => {
        const row = state.getSnapshot().rows.find((item) => item.key === request.key);
        if (!row || row.generation !== request.generation || row.revision !== request.revision)
          throw new ActivityError({ reason: "stale" });
        return row;
      };
      const providerFor = (request: ActivityDetailRequest) =>
        state.getState.pipe(
          Effect.flatMap((current) => {
            const row = current.rows.find((item) => item.key === request.key);
            const provider = row ? current.providers.get(row.providerId) : undefined;
            const item = provider?.items.find((value) => value.key === request.key);
            return !current.closed &&
              provider &&
              item &&
              item.generation === request.generation &&
              item.revision === request.revision
              ? Effect.succeed({ provider, item })
              : Effect.fail(new ActivityError({ reason: "stale" }));
          }),
        );
      const invoke = (request: ActivityActionRequest) =>
        Effect.gen(function* () {
          const { provider, item } = yield* providerFor(request);
          yield* Effect.tryPromise({
            try: (signal) => {
              // Recheck the frozen current projection immediately before invoking the captured capability.
              const row = checkedRow(request);
              if (!row.actions?.some((action) => action.id === request.actionId))
                throw new ActivityError({ reason: "stale" });
              return provider.invoke(item.id, request.actionId, request.revision, signal);
            },
            catch: (error) => (error instanceof ActivityError ? error : failed()),
          });
        });
      const detail = (request: ActivityDetailRequest) =>
        Effect.gen(function* () {
          const { provider, item } = yield* providerFor(request);
          const getDetail = provider.getDetail;
          if (!getDetail) return item.detail ?? "";
          const text = yield* Effect.tryPromise({
            try: (signal) => {
              checkedRow(request);
              return getDetail(item.id, request.revision, signal);
            },
            catch: (error) => (error instanceof ActivityError ? error : failed()),
          });
          const decoded = yield* Schema.decodeUnknownEffect(Schema.String)(text).pipe(
            Effect.mapError(() => new ActivityError({ reason: "invalid" })),
          );
          return yield* Effect.try({
            try: () => {
              checkedRow(request);
              return cleanDetail(decoded);
            },
            catch: (error) => (error instanceof ActivityError ? error : failed()),
          });
        });
      yield* Effect.addFinalizer(() =>
        state
          .transition((old) =>
            Effect.gen(function* () {
              for (const provider of old.providers.values())
                yield* callback(() => provider.acknowledge(false)).pipe(Effect.ignore);
              return [
                undefined,
                { ...old, closed: true, providers: new Map(), retired: new Set(), rows: [] },
              ] as const;
            }),
          )
          .pipe(Effect.ignore),
      );
      const service = {
        receive,
        invoke,
        detail,
        snapshot: Effect.sync(() => state.getSnapshot().rows),
      } satisfies ActivityServiceContract;
      if (options.connect)
        yield* Effect.acquireRelease(
          Effect.try({ try: () => options.connect!(service), catch: failed }),
          (release) => callback(release).pipe(Effect.ignore),
        );
      const tick = options.tick;
      if (tick) {
        const updateClock = Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => callback(() => tick(now))),
          Effect.ignore,
        );
        yield* updateClock;
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.suspend(() => {
              const { rows, starting } = state.getSnapshot();
              return Effect.sleep(
                starting > 0 ||
                  rows.some((row) => row.status === "running" || row.status === "pending")
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
