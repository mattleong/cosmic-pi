import * as Context from "effect/Context";
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
  McpPromptMetadataSchema,
  McpResourceMetadataSchema,
  McpTemplateMetadataSchema,
  McpToolMetadataSchema,
  type McpDiscoveryContract,
  type McpDiscoveryRequest,
  type McpMetadataSnapshot,
} from "./model.ts";
import {
  discoveryPage,
  emptyCursorState,
  freezeMetadata,
  listMetadata,
  metadataBudget,
  type McpCursorState,
} from "./pagination.ts";
import { isToolAllowed, requireToolAllowed } from "./policy.ts";

interface DiscoveryState {
  readonly revision: number;
  readonly snapshots: ReadonlyMap<string, McpMetadataSnapshot>;
  readonly consumers: ReadonlyMap<string, string>;
  readonly cursors: McpCursorState;
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
      const server = config.servers[snapshot.server];
      return (
        config.trusted &&
        config.settings.enabled &&
        server?.enabled &&
        server.identity === snapshot.identity
      );
    })
    .sort((left, right) => left.server.localeCompare(right.server));

const makeDiscovery = Effect.gen(function* () {
  const connections = yield* McpConnections;
  const state = yield* SynchronizedRef.make<DiscoveryState>({
    revision: 0,
    snapshots: new Map(),
    consumers: new Map(),
    cursors: emptyCursorState(),
  });
  const namespace = `mcp-${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16)}-${(yield* Random.nextIntBetween(0, 0xffff_ffff)).toString(16)}`;

  // Registry calls this while holding its lock. This callback touches local state only.
  yield* connections.subscribeRevocations((servers) =>
    SynchronizedRef.update(state, (current) => {
      const snapshots = new Map(current.snapshots);
      const consumers = new Map(current.consumers);
      for (const server of servers) {
        snapshots.delete(server);
        consumers.delete(server);
      }
      return {
        ...current,
        snapshots,
        consumers,
        cursors: { ...current.cursors, entries: new Map() },
      };
    }),
  );

  const expireOwner = (server: string, owner: string) =>
    SynchronizedRef.update(state, (current) => {
      const snapshots = new Map(current.snapshots);
      const consumers = new Map(current.consumers);
      if (consumers.get(server) === owner) consumers.delete(server);
      if (snapshots.get(server)?.owner === owner) snapshots.delete(server);
      return { ...current, snapshots, consumers };
    });

  const fetchSnapshot = (
    operation: McpOperation,
  ): Effect.Effect<McpMetadataSnapshot, McpBoundaryError> =>
    Effect.gen(function* () {
      const budget = metadataBudget();
      const tools = operation.capabilities.tools
        ? yield* listMetadata(
            operation,
            "tools.list",
            "tools",
            McpToolMetadataSchema,
            (tool) => tool.name,
            budget,
          )
        : [];
      const resources = operation.capabilities.resources
        ? yield* listMetadata(
            operation,
            "resources.list",
            "resources",
            McpResourceMetadataSchema,
            (resource) => resource.uri,
            budget,
          )
        : [];
      const templates = operation.capabilities.resources
        ? yield* listMetadata(
            operation,
            "resources.templates",
            "resourceTemplates",
            McpTemplateMetadataSchema,
            (template) => template.uriTemplate,
            budget,
          )
        : [];
      const prompts = operation.capabilities.prompts
        ? yield* listMetadata(
            operation,
            "prompts.list",
            "prompts",
            McpPromptMetadataSchema,
            (prompt) => prompt.name,
            budget,
          )
        : [];
      const prepared = yield* Effect.try({
        try: () =>
          freezeMetadata(
            structuredClone({
              tools: tools.filter((tool) => isToolAllowed(operation.server, tool.name)),
              resources,
              templates,
              prompts,
            }),
          ),
        catch: () =>
          boundaryError("output-limit", "not-sent", "Unable to prepare MCP metadata snapshot."),
      });
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
            return [snapshot, { ...current, revision: snapshot.revision, snapshots }];
          },
        ),
      );
      return published === undefined
        ? yield* boundaryError("stale", "not-sent", "MCP metadata owner has expired.")
        : published;
    }).pipe(Effect.withSpan("pi-mcp.discovery.refresh"));

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
        try: (): readonly [Schema.Json, DiscoveryState] => {
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
            { page: result.data, undiscovered },
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
            return yield* operation.commit(Effect.succeed(tool));
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
    known: Effect.gen(function* () {
      const config = yield* connections.config;
      return visibleSnapshots(yield* SynchronizedRef.get(state), config).map((snapshot) => ({
        server: snapshot.server,
        revision: snapshot.revision,
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
