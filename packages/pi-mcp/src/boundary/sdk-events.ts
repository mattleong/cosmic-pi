import {
  SUBSCRIPTION_ID_META_KEY,
  type Client,
  type RequestOptions,
  type SubscriptionFilter,
  type Transport,
} from "@modelcontextprotocol/client";
import { SDK_OPERATION_HEADER } from "./sdk-fetch.ts";
import { decorateTransport } from "./sdk-transport.ts";
import { invokeHostCallback, makeNativeContext } from "pi-cosmic-core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { SdkSubscriptionTrafficLedger } from "./sdk-subscription-traffic.ts";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpRemoteEvent, McpProgress } from "../observations/model.ts";
import type { McpCapabilities, McpMetadataFamily, McpDispatchOptions } from "../client/model.ts";

export interface SdkConnectionState {
  closing: boolean;
  closed: boolean;
  cleanupUnconfirmed: boolean;
  observationCleanupFailed?: boolean;
}

/** Native observer errors cannot replace cleanup evidence or skip finalization. */
export const observeSdkCleanup = (
  observer: ((confirmed: boolean) => void) | undefined,
  confirmed: boolean,
): void => {
  // This private observer reports evidence only; it owns no resource cleanup.
  invokeHostCallback(() => observer?.(confirmed), undefined);
};

export const sdkCapabilities = (
  client: Client,
  http = false,
): Effect.Effect<McpCapabilities, McpBoundaryError> =>
  Effect.try({
    try: () => {
      const capabilities = client.getServerCapabilities();
      const modern = client.getProtocolEra() === "modern";
      return Object.freeze({
        tools: capabilities?.tools !== undefined,
        resources: capabilities?.resources !== undefined,
        prompts: capabilities?.prompts !== undefined,
        parameterHeaders: http && modern,
        completions: capabilities?.completions !== undefined,
        resourceSubscriptions: capabilities?.resources?.subscribe === true,
        multiRoundTrip: modern,
        requestLogging: http && modern && capabilities?.logging !== undefined,
      });
    },
    catch: () => boundaryError("protocol", "not-sent", "MCP capabilities are unavailable."),
  });

export interface SdkSubscriptionTraffic {
  readonly options: RequestOptions;
  readonly mapFailure?: (cause: unknown) => McpBoundaryError;
  readonly close: Effect.Effect<void, McpBoundaryError>;
  readonly run: <A>(callback: () => A) => A;
}
interface SubscriptionEntry {
  readonly kind: "subscription";
  readonly identity: symbol;
  readonly writes: SdkSubscriptionTrafficLedger;
  readonly requests: Set<string | number>;
  readonly pending: string[];
  acknowledged: ReadonlyArray<string> | undefined;
  accepting: boolean;
  id?: string | number;
  filter?: SubscriptionFilter;
}
interface ProgressEntry {
  readonly kind: "progress";
  readonly callback: (value: McpProgress) => void;
  id?: string | number;
  token?: string | number;
}
const ProgressToken = Schema.Union([Schema.String, Schema.Finite]);
const Cancellation = Schema.Struct({ params: Schema.Struct({ requestId: ProgressToken }) });
const ProgressRequest = Schema.Struct({
  params: Schema.Struct({ _meta: Schema.Struct({ progressToken: ProgressToken }) }),
});
const ProgressNotification = Schema.Struct({
  params: Schema.Struct({
    progressToken: ProgressToken,
    progress: Schema.Finite,
    total: Schema.optionalKey(Schema.Finite),
    message: Schema.optionalKey(Schema.String),
  }),
});
// Raw ACK evidence only permits bounded staging. The SDK and adapter must still
// accept the acknowledgement and exact honored filter before anything is queued.
const SubscriptionAcknowledgement = Schema.Struct({
  params: Schema.Struct({
    _meta: Schema.Struct({ [SUBSCRIPTION_ID_META_KEY]: ProgressToken }),
    notifications: Schema.Struct({
      toolsListChanged: Schema.optionalKey(Schema.Boolean),
      resourcesListChanged: Schema.optionalKey(Schema.Boolean),
      promptsListChanged: Schema.optionalKey(Schema.Boolean),
      resourceSubscriptions: Schema.optionalKey(
        Schema.Array(Schema.String.check(Schema.isMaxLength(1_024))).check(Schema.isMaxLength(32)),
      ),
    }),
  }),
});
const SubscriptionNotification = Schema.Struct({
  params: Schema.Struct({
    uri: Schema.String.check(Schema.isMaxLength(1_024)),
    _meta: Schema.optionalKey(
      Schema.Struct({
        [SUBSCRIPTION_ID_META_KEY]: Schema.optionalKey(ProgressToken),
      }),
    ),
  }),
});

/** Bounded callback ingress. No SDK callback runs an Effect or refreshes metadata. */
export const makeSdkEvents = (
  client: Client,
  state: SdkConnectionState,
  beginTraffic?: () => Effect.Effect<SdkSubscriptionTraffic, McpBoundaryError>,
  cleanupOptions = { timeoutMs: 1_000, requireCancellationWrite: false },
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<McpMetadataFamily, Cause.Done>({
      capacity: 3,
      strategy: "dropping",
    });
    const remote = yield* Queue.make<McpRemoteEvent, Cause.Done>({
      capacity: 32,
      strategy: "dropping",
    });
    const terminal = yield* Deferred.make<void, McpBoundaryError>();
    const pending = new Set<McpMetadataFamily>();
    const subscriptions = new Map<string, SubscriptionEntry>();
    const progress = new Map<string | number, ProgressEntry>();
    const context = yield* makeNativeContext<SubscriptionEntry | ProgressEntry>().pipe(
      Effect.mapError(() =>
        boundaryError("connection", "not-sent", "MCP native observation context is unavailable."),
      ),
    );
    let nextSubscription = 0;
    const accepts = (id: string | number | undefined, uri: string) =>
      [...subscriptions.values()].find(
        (entry) =>
          entry.accepting &&
          entry.id === id &&
          (entry.filter?.resourceSubscriptions?.includes(uri) ||
            (id !== undefined && entry.acknowledged?.includes(uri) && entry.filter === undefined)),
      );
    let ended = false;
    let remoteDropped = 0;
    const offerRemote = (event: McpRemoteEvent) => {
      if (!Queue.offerUnsafe(remote, event))
        remoteDropped = Math.min(Number.MAX_SAFE_INTEGER, remoteDropped + 1);
    };
    const finish = (failure?: McpBoundaryError): void => {
      if (ended) return;
      ended = true;
      progress.clear();
      for (const entry of subscriptions.values()) entry.pending.length = 0;
      Queue.endUnsafe(queue);
      Queue.endUnsafe(remote);
      Deferred.doneUnsafe(terminal, failure === undefined ? Effect.void : Effect.fail(failure));
    };
    let observation: "active" | "failed" = "active";
    const observationFailed = (): void => {
      if (ended || state.closing) return;
      observation = "failed";
      state.closing = true;
      finish(boundaryError("transport", "unknown", "MCP metadata observation failed."));
    };
    const changed = (family: McpMetadataFamily): void => {
      if (ended || state.closing || pending.has(family)) return;
      pending.add(family);
      if (!Queue.offerUnsafe(queue, family)) pending.delete(family);
    };
    yield* Effect.try({
      try: () => {
        // Public typed methods select the SDK's exported wire schemas internally.
        client.setNotificationHandler("notifications/tools/list_changed", () => changed("tools"));
        client.setNotificationHandler("notifications/resources/list_changed", () =>
          changed("resources"),
        );
        client.setNotificationHandler("notifications/prompts/list_changed", () =>
          changed("prompts"),
        );
        // Logs require exact HTTP request-stream proof at the raw transport ingress.
        client.setNotificationHandler("notifications/message", () => {});
        // Raw ingress stamps a private generation before the SDK strips subscription metadata.
        client.setNotificationHandler("notifications/resources/updated", () => {});
        client.onclose = () => {
          if (state.closing) return;
          state.closing = true;
          state.closed = true;
          finish(boundaryError("transport", "unknown", "MCP connection closed unexpectedly."));
        };
        // SDK onerror also reports individual HTTP failures. It is not terminal evidence.
      },
      catch: () => boundaryError("connection", "not-sent", "Unable to observe MCP connection."),
    });
    return {
      beginSubscription: (identity = Symbol("MCP subscription")) =>
        Effect.gen(function* () {
          const traffic = beginTraffic ? yield* beginTraffic() : undefined;
          const tag =
            traffic?.options.headers?.[SDK_OPERATION_HEADER] ??
            `subscription:${++nextSubscription}`;
          const entry: SubscriptionEntry = {
            kind: "subscription",
            identity,
            writes: new SdkSubscriptionTrafficLedger(),
            requests: new Set(),
            pending: [],
            acknowledged: undefined,
            accepting: true,
          };
          subscriptions.set(tag, entry);
          const close = yield* Effect.cached(
            Effect.uninterruptible(
              Effect.gen(function* () {
                entry.accepting = false;
                entry.pending.length = 0;
                entry.acknowledged = undefined;
                const writes = yield* Effect.exit(
                  entry.writes.join(
                    cleanupOptions.timeoutMs,
                    cleanupOptions.requireCancellationWrite && entry.id !== undefined,
                  ),
                );
                const native = yield* Effect.exit(traffic?.close ?? Effect.void);
                if (Exit.isFailure(writes)) return yield* Effect.failCause(writes.cause);
                if (Exit.isFailure(native)) return yield* Effect.failCause(native.cause);
                subscriptions.delete(tag);
              }),
            ),
          );
          return {
            identity: entry.identity,
            options: traffic?.options ?? { headers: { [SDK_OPERATION_HEADER]: tag } },
            mapFailure: traffic?.mapFailure,
            run: <A>(callback: () => A): A =>
              context.run(entry, () => (traffic ? traffic.run(callback) : callback())),
            acknowledge: (filter: SubscriptionFilter) => {
              entry.filter = filter;
              if (entry.accepting && !ended && !state.closing)
                for (const uri of entry.pending)
                  if (filter.resourceSubscriptions?.includes(uri))
                    offerRemote({ kind: "resource-updated", uri, subscription: entry.identity });
              entry.pending.length = 0;
            },
            close,
          };
        }),
      withProgress: <A>(
        options: McpDispatchOptions | undefined,
        request: (dispatch: McpDispatchOptions | undefined) => Promise<A>,
      ): Promise<A> => {
        if (!options?.onprogress) return request(options);
        const entry: ProgressEntry = { kind: "progress", callback: options.onprogress };
        return context
          .run(entry, () => request({ ...options, onprogress: () => {} }))
          .finally(() => {
            if (entry.token !== undefined) progress.delete(entry.token);
          });
      },
      bindTransport: (transport: Transport): Transport =>
        decorateTransport(transport, {
          send: (message, options) => {
            const tag = options?.headers?.[SDK_OPERATION_HEADER];
            let entry =
              (tag === undefined ? undefined : subscriptions.get(tag)) ?? context.current();
            const cancelling =
              "method" in message && message.method === "notifications/cancelled"
                ? Schema.decodeUnknownOption(Cancellation)(message)
                : Option.none();
            if (Option.isSome(cancelling))
              entry =
                [...subscriptions.values()].find((owner) =>
                  owner.requests.has(cancelling.value.params.requestId),
                ) ?? entry;
            if (entry?.kind === "subscription" && "id" in message && "method" in message) {
              entry.requests.add(message.id);
              if (message.method === "subscriptions/listen") entry.id = message.id;
            }
            if (entry?.kind === "progress" && "id" in message && "method" in message) {
              const value = Schema.decodeUnknownOption(ProgressRequest)(message);
              if (Option.isSome(value)) {
                entry.id = message.id;
                entry.token = value.value.params._meta.progressToken;
                progress.set(entry.token, entry);
              }
            }
            if (entry?.kind !== "subscription" || !cleanupOptions.requireCancellationWrite)
              return transport.send(message, options);
            const settled = entry.writes.reserve(Option.isSome(cancelling));
            if (!settled)
              return Promise.reject(
                boundaryError("cleanup", "unknown", "MCP subscription write ownership is closed."),
              );
            try {
              return transport.send(message, options).then(
                () => settled(true),
                (error) => {
                  settled(false);
                  throw error;
                },
              );
            } catch (error) {
              settled(false);
              return Promise.reject(error);
            }
          },
          receive: (message) => {
            const method = "method" in message ? message.method : undefined;
            if (method === undefined && "id" in message) {
              for (const entry of subscriptions.values())
                if (entry.id === message.id) entry.writes.remoteTerminated();
              for (const [token, entry] of progress)
                if (entry.id === message.id) progress.delete(token);
            } else if (method === "notifications/progress" && !ended && !state.closing) {
              const value = Schema.decodeUnknownOption(ProgressNotification)(message);
              if (Option.isSome(value)) {
                try {
                  const { progressToken, ...reported } = value.value.params;
                  progress.get(progressToken)?.callback(reported);
                } catch {
                  /* Progress is observational. */
                }
              }
            }
            if (method === "notifications/subscriptions/acknowledged") {
              const acknowledged = Schema.decodeUnknownOption(SubscriptionAcknowledgement)(message);
              if (Option.isSome(acknowledged))
                for (const entry of subscriptions.values())
                  if (
                    entry.accepting &&
                    entry.acknowledged === undefined &&
                    entry.id === acknowledged.value.params._meta[SUBSCRIPTION_ID_META_KEY]
                  )
                    entry.acknowledged =
                      acknowledged.value.params.notifications.resourceSubscriptions ?? [];
            }
            if (method === "notifications/cancelled") {
              const cancelled = Schema.decodeUnknownOption(Cancellation)(message);
              if (Option.isSome(cancelled))
                for (const entry of subscriptions.values())
                  if (entry.id === cancelled.value.params.requestId)
                    entry.writes.remoteTerminated();
            }
            if (method === "notifications/resources/updated") {
              if (ended || state.closing) return false;
              const value = Schema.decodeUnknownOption(SubscriptionNotification)(message);
              if (Option.isNone(value)) return false;
              const { uri, _meta } = value.value.params;
              // Modern updates name their listen stream; legacy notifications cannot.
              const modern = client.getProtocolEra() === "modern";
              const id = modern ? _meta?.[SUBSCRIPTION_ID_META_KEY] : undefined;
              if (modern && id === undefined) return false;
              const entry = accepts(id, uri);
              if (!entry) return false;
              if (entry.filter === undefined) {
                if (entry.pending.length < 32) entry.pending.push(uri);
                else remoteDropped = Math.min(Number.MAX_SAFE_INTEGER, remoteDropped + 1);
              } else offerRemote({ kind: "resource-updated", uri, subscription: entry.identity });
            }
            return true;
          },
        }),
      remoteEvents: Stream.fromQueue(remote),
      remoteEventDrops: Effect.sync(() => remoteDropped),
      changes: Stream.fromQueue(queue).pipe(
        Stream.map((family) => {
          pending.delete(family);
          return family;
        }),
      ),
      terminal: Deferred.await(terminal),
      health: Effect.sync(() => ({
        closed: state.closing || state.closed,
        cleanupUnconfirmed: state.cleanupUnconfirmed,
        observation,
      })),
      finish,
      observationFailed,
      cleanupFailed: () => {
        state.observationCleanupFailed = true;
        state.cleanupUnconfirmed = true;
        finish(boundaryError("cleanup", "unknown", "MCP observation cleanup failed."));
      },
    };
  });

export type SdkEvents = Effect.Success<ReturnType<typeof makeSdkEvents>>;
