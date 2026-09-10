import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { McpActivity } from "../activity/service.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import type * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";
import type { McpResolvedConfig } from "../config/model.ts";
import type { McpOperation } from "../connection/model.ts";
import { McpConnections } from "../connection/service.ts";
import {
  type McpDiscoveryQueryResult,
  type McpDiscoveryContract,
  type McpDiscoveryRequest,
  type McpMetadataSnapshot,
} from "./model.ts";
import { discoveryPage, emptyCursorState, type McpCursorState } from "./pagination.ts";
import { isToolAllowed, requireToolAllowed } from "./policy.ts";
import { cacheVisible, describeCached, queryCached, type McpCacheEvidence } from "./cached.ts";
import { collectMetadata } from "./collect.ts";
import { discoveryNotices } from "./diagnostics.ts";

interface DiscoveryState {
  readonly revision: number;
  readonly snapshots: ReadonlyMap<string, McpMetadataSnapshot>;
  readonly consumers: ReadonlyMap<string, string>;
  readonly cursors: McpCursorState;
  readonly evidence: ReadonlyMap<string, McpCacheEvidence>;
}
const matches = (
  snapshot: McpMetadataSnapshot | undefined,
  operation: McpOperation,
): snapshot is McpMetadataSnapshot =>
  snapshot !== undefined &&
  snapshot.owner === operation.owner &&
  snapshot.identity === operation.binding.identity &&
  snapshot.configRevision === operation.binding.configRevision;
const visibleSnapshots = (state: DiscoveryState, config: McpResolvedConfig) =>
  [...state.snapshots.values()]
    .filter((snapshot) => {
      return cacheVisible(snapshot, config);
    })
    .sort((left, right) => left.server.localeCompare(right.server));

const makeDiscovery = Effect.gen(function* () {
  const connections = yield* McpConnections;
  const activity = yield* McpActivity;
  const state = yield* SynchronizedRef.make<DiscoveryState>({
    revision: 0,
    snapshots: new Map(),
    consumers: new Map(),
    cursors: emptyCursorState(),
    evidence: new Map(),
  });
  const listeners = new Set<() => void>();
  const changed = Effect.sync(() => {
    for (const listener of listeners) listener();
  });
  const namespace = `mcp-${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16)}-${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16)}`;

  // Registry calls this while holding its lock. This callback touches local state only.
  yield* connections.subscribeRevocations((servers) =>
    SynchronizedRef.update(state, (current) => {
      const snapshots = new Map(current.snapshots);
      const consumers = new Map(current.consumers);
      const evidence = new Map(current.evidence);
      for (const server of servers) {
        snapshots.delete(server);
        consumers.delete(server);
        evidence.set(server, { owner: "", state: "invalidated" });
      }
      return {
        ...current,
        snapshots,
        consumers,
        evidence,
        cursors: { ...current.cursors, entries: new Map() },
      };
    }).pipe(Effect.andThen(changed)),
  );

  const expireOwner = (server: string, owner: string) =>
    SynchronizedRef.update(state, (current) => {
      const snapshots = new Map(current.snapshots);
      const consumers = new Map(current.consumers);
      if (consumers.get(server) === owner) consumers.delete(server);
      const evidence = new Map(current.evidence);
      if (snapshots.get(server)?.owner === owner) {
        snapshots.delete(server);
        evidence.set(server, { owner, state: "invalidated" });
      }
      if (evidence.get(server)?.owner === owner)
        evidence.set(server, { owner, state: "invalidated" });
      return { ...current, snapshots, consumers, evidence };
    }).pipe(Effect.andThen(changed));

  const observing = (operation: McpOperation, phase: "refreshing" | "refresh-failed") =>
    SynchronizedRef.update(state, (current) => {
      if (current.consumers.get(operation.binding.server) !== operation.owner) return current;
      const evidence = new Map(current.evidence);
      evidence.set(operation.binding.server, { owner: operation.owner, state: phase });
      return { ...current, evidence };
    }).pipe(Effect.andThen(changed));

  const collectSnapshot = (
    operation: McpOperation,
  ): Effect.Effect<McpMetadataSnapshot, McpBoundaryError> =>
    Effect.gen(function* () {
      yield* observing(operation, "refreshing");
      const prepared = yield* collectMetadata(operation);
      const published = yield* operation.commit(
        SynchronizedRef.modify(
          state,
          (current): readonly [McpMetadataSnapshot | undefined, DiscoveryState] => {
            if (current.consumers.get(operation.binding.server) !== operation.owner)
              return [undefined, current];
            const snapshot: McpMetadataSnapshot = Object.freeze({
              server: operation.binding.server,
              identity: operation.binding.identity,
              configRevision: operation.binding.configRevision,
              owner: operation.owner,
              revision: current.revision + 1,
              ...prepared,
            });
            const snapshots = new Map(current.snapshots);
            snapshots.set(snapshot.server, snapshot);
            const evidence = new Map(current.evidence);
            evidence.delete(snapshot.server);
            return [snapshot, { ...current, revision: snapshot.revision, snapshots, evidence }];
          },
        ),
      );
      yield* changed;
      return published === undefined
        ? yield* boundaryError("stale", "not-sent", "MCP metadata owner has expired.")
        : published;
    }).pipe(
      Effect.onError(() => observing(operation, "refresh-failed")),
      Effect.withSpan("pi-mcp.discovery.refresh"),
    );

  const fetchSnapshot = (operation: McpOperation) =>
    Effect.gen(function* () {
      const handle = yield* activity.begin({
        operation: "refresh",
        server: operation.binding.server,
      });
      yield* activity.update(handle, { phase: "refreshing" });
      return yield* collectSnapshot(operation).pipe(
        Effect.onExit((exit) => {
          const error = Exit.isFailure(exit)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : undefined;
          return activity.finish(
            handle,
            Exit.isSuccess(exit)
              ? { status: "done" }
              : error
                ? error.reason === undefined
                  ? { status: "failed", kind: error.kind }
                  : { status: "failed", kind: error.kind, reason: error.reason }
                : { status: "cancelled" },
          );
        }),
      );
    });

  const watch = (operation: McpOperation): Effect.Effect<void, McpBoundaryError> =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        const admitted = yield* operation.commit(
          SynchronizedRef.modify(state, (current) => {
            if (current.consumers.get(operation.binding.server) === operation.owner)
              return [false, current];
            const consumers = new Map(current.consumers);
            consumers.set(operation.binding.server, operation.owner);
            return [true, { ...current, consumers }];
          }),
        );
        if (!admitted) return;
        // Only shared's fresh operation owns requests and publication. The original ticket may be closed.
        yield* operation
          .forkOwned(
            operation.changes.pipe(
              Stream.debounce("20 millis"),
              Stream.runForEach(() =>
                operation.shared("metadata", fetchSnapshot).pipe(Effect.catch(() => Effect.void)),
              ),
              Effect.ensuring(expireOwner(operation.binding.server, operation.owner)),
            ),
          )
          .pipe(Effect.onError(() => expireOwner(operation.binding.server, operation.owner)));
      }),
    );

  const refresh: McpDiscoveryContract["refresh"] = (operation) =>
    Effect.gen(function* () {
      yield* watch(operation);
      return yield* operation.shared("metadata", fetchSnapshot);
    });
  const ensure: McpDiscoveryContract["ensure"] = (operation) =>
    Effect.gen(function* () {
      yield* watch(operation);
      const existing = yield* operation.commit(SynchronizedRef.get(state));
      const snapshot = existing.snapshots.get(operation.binding.server);
      if (matches(snapshot, operation)) return snapshot;
      return yield* operation.shared("metadata", (owner) =>
        Effect.gen(function* () {
          const latest = yield* owner.commit(SynchronizedRef.get(state));
          const ready = latest.snapshots.get(owner.binding.server);
          return matches(ready, owner) ? ready : yield* fetchSnapshot(owner);
        }),
      );
    });

  const page = (
    request: Exclude<McpDiscoveryRequest, { readonly action: "tools.describe" }>,
    config: McpResolvedConfig,
    targeted?: McpMetadataSnapshot,
  ) =>
    SynchronizedRef.modifyEffect(state, (current) =>
      Effect.try({
        try: (): readonly [McpDiscoveryQueryResult, DiscoveryState] => {
          const snapshots = targeted === undefined ? visibleSnapshots(current, config) : [targeted];
          if (targeted !== undefined && current.snapshots.get(targeted.server) !== targeted)
            throw boundaryError(
              "stale",
              "not-sent",
              "MCP metadata changed before the page was published.",
            );
          const filter = request.action === "tools.search" ? request.query.toLocaleLowerCase() : "";
          const items: Array<Schema.Json> = [];
          for (const snapshot of snapshots) {
            if (request.action === "tools.list" || request.action === "tools.search") {
              const server = config.servers[snapshot.server];
              for (const tool of snapshot.tools) {
                if (!server || !isToolAllowed(server, tool.name)) continue;
                if (
                  filter !== "" &&
                  !`${tool.name}\n${tool.description ?? ""}`.toLocaleLowerCase().includes(filter)
                )
                  continue;
                items.push({ ...tool, server: snapshot.server });
              }
            } else {
              const entries =
                request.action === "resources.list"
                  ? snapshot.resources
                  : request.action === "resources.templates"
                    ? snapshot.templates
                    : snapshot.prompts;
              items.push(...entries);
            }
          }
          const signature = [
            request.action,
            request.server ?? "",
            filter,
            String(config.revision),
            ...snapshots.flatMap((snapshot) => [
              snapshot.server,
              snapshot.owner,
              snapshot.identity,
              String(snapshot.revision),
            ]),
          ]
            .map((part) => `${part.length}:${part}`)
            .join("");
          const result = discoveryPage(items, request, signature, namespace, current.cursors);
          const discovered = new Set(snapshots.map((snapshot) => snapshot.server));
          const undiscovered =
            targeted === undefined
              ? Object.values(config.servers)
                  .filter((server) => server.enabled && !discovered.has(server.id))
                  .map((server) => server.id)
                  .sort()
              : [];
          return [
            { data: { page: result.data, undiscovered }, notices: discoveryNotices(snapshots) },
            { ...current, cursors: result.state },
          ];
        },
        catch: (error) =>
          error instanceof McpBoundaryError
            ? error
            : boundaryError("protocol", "not-sent", "Unable to prepare MCP discovery page."),
      }),
    );

  const query: McpDiscoveryContract["query"] = (request, admitted) =>
    Effect.gen(function* () {
      if (
        (request.action === "tools.list" || request.action === "tools.search") &&
        request.server === undefined
      ) {
        const config = yield* connections.config;
        if (!config.trusted || !config.settings.enabled)
          return yield* Effect.fail(
            boundaryError(
              "denied",
              "not-sent",
              "MCP discovery requires an enabled trusted session.",
            ),
          );
        return yield* page(request, config);
      }
      const server = request.server;
      if (server === undefined || (admitted !== undefined && admitted.binding.server !== server))
        return yield* Effect.fail(
          boundaryError(
            "invalid-input",
            "not-sent",
            "MCP discovery server does not match the admitted operation.",
          ),
        );
      const use = (operation: McpOperation) =>
        Effect.gen(function* () {
          if (request.action === "tools.describe")
            yield* requireToolAllowed(operation.server, request.tool);
          const snapshot = yield* ensure(operation);
          if (request.action === "tools.describe") {
            const tool = snapshot.tools.find((item) => item.name === request.tool);
            if (tool === undefined)
              return yield* Effect.fail(
                boundaryError("not-found", "not-sent", "MCP tool was not found."),
              );
            return yield* operation.commit(
              Effect.succeed({ data: tool, notices: discoveryNotices([snapshot]) }),
            );
          }
          const config = yield* connections.config;
          return yield* operation
            .commit(Effect.result(page(request, config, snapshot)))
            .pipe(Effect.flatMap((result) => Effect.fromResult(result)));
        });
      return yield* admitted === undefined
        ? connections.withOperation(server, {}, use)
        : use(admitted);
    });

  return {
    ensure,
    refresh,
    query,
    subscribeChanges: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    cached: (request) =>
      Effect.gen(function* () {
        const config = yield* connections.config;
        return yield* SynchronizedRef.modifyEffect(state, (current) =>
          Effect.try({
            try: () => {
              const result = queryCached(
                request,
                config,
                current.snapshots,
                current.evidence,
                current.cursors,
                namespace,
              );
              return [result.page, { ...current, cursors: result.cursors }] as const;
            },
            catch: (error) =>
              error instanceof McpBoundaryError
                ? error
                : boundaryError("protocol", "not-sent", "MCP cached query is unavailable."),
          }),
        );
      }),
    cachedDetail: (ref) =>
      Effect.gen(function* () {
        const config = yield* connections.config;
        const current = yield* SynchronizedRef.get(state);
        return yield* Effect.try({
          try: () => describeCached(ref, config, current.snapshots),
          catch: (error) =>
            error instanceof McpBoundaryError
              ? error
              : boundaryError("protocol", "not-sent", "MCP cached detail is unavailable."),
        });
      }),
    known: Effect.gen(function* () {
      const config = yield* connections.config;
      return visibleSnapshots(yield* SynchronizedRef.get(state), config).map((snapshot) => ({
        server: snapshot.server,
        revision: snapshot.revision,
        support: snapshot.support,
        diagnostics: snapshot.diagnostics,
        tools: snapshot.tools.length,
        resources: snapshot.resources.length,
        templates: snapshot.templates.length,
        prompts: snapshot.prompts.length,
      }));
    }),
  } satisfies McpDiscoveryContract;
});

export class McpDiscovery extends Context.Service<McpDiscovery, McpDiscoveryContract>()(
  "pi-mcp/discovery/service/McpDiscovery",
) {
  static readonly layer = Layer.effect(McpDiscovery, makeDiscovery);
}
