import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AgentDirectory, freezeSnapshot, JsonDocumentStore, type JsonObject } from "pi-cosmic-core";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpConfigScope, McpConfigStoreContract, McpResolvedConfig } from "./model.ts";
import { resolveMcpConfig, type McpConfigSource } from "./options.ts";
import {
  checkConfigBounds,
  decodeMcpDocument,
  decodeMcpServer,
  MCP_CONFIG_BASENAME,
  MCP_CONFIG_LIMITS,
  McpServerIdSchema,
  McpSettingsPatchSchema,
} from "./schema.ts";

export interface McpConfigStoreOptions {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}
type Publisher = { readonly publish: (config: McpResolvedConfig) => Effect.Effect<void> };
const readLimits = { maxBytes: MCP_CONFIG_LIMITS.bytes };

const configError = () =>
  boundaryError("config", "not-sent", "Unable to read or persist MCP configuration.");
const invalidInput = () =>
  boundaryError("invalid-input", "not-sent", "Invalid MCP configuration change.");
const freezeConfig = (config: McpResolvedConfig) =>
  Effect.try({ try: () => freezeSnapshot(config), catch: configError });

/** One persistence door and one current scoped execution subscriber. No credentials are resolved here. */
export class McpConfigStore extends Context.Service<McpConfigStore, McpConfigStoreContract>()(
  "pi-mcp/config/store/McpConfigStore",
) {
  static readonly layer = (options: McpConfigStoreOptions) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const agentDirectory = yield* AgentDirectory;
        const documents = yield* JsonDocumentStore;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const globalSource: McpConfigSource = {
          scope: "global",
          directory: path.resolve(agentDirectory),
          path: path.resolve(agentDirectory, "extensions", MCP_CONFIG_BASENAME),
        };
        // Constructing this path is pure. No project filesystem capability is used without trust.
        const projectSource: McpConfigSource = {
          scope: "project",
          directory: path.resolve(options.cwd),
          path: path.resolve(options.cwd, CONFIG_DIR_NAME, "extensions", MCP_CONFIG_BASENAME),
        };
        const updates = yield* Semaphore.make(1);
        const subscriber = yield* Ref.make<Publisher | undefined>(undefined);

        const readSource = (source: McpConfigSource): Effect.Effect<McpConfigSource> =>
          documents.readObject(source.path, readLimits).pipe(
            Effect.flatMap((document) =>
              document === undefined
                ? Effect.succeed(source)
                : decodeMcpDocument(document).pipe(
                    Effect.map((decoded) => ({ ...source, document: decoded })),
                  ),
            ),
            Effect.catch(() =>
              Effect.succeed({
                ...source,
                diagnostic:
                  source.scope === "project"
                    ? "Project MCP configuration is unreadable or invalid."
                    : "Global MCP configuration is unreadable or invalid.",
              }),
            ),
          );
        const resolve = (revision: number, global: McpConfigSource, project?: McpConfigSource) =>
          resolveMcpConfig({
            revision,
            trusted: options.projectTrusted,
            global,
            project,
            path,
          }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.flatMap(freezeConfig));
        const readConfig = (revision: number) =>
          Effect.gen(function* () {
            const global = yield* readSource(globalSource);
            const project = options.projectTrusted ? yield* readSource(projectSource) : undefined;
            return yield* resolve(revision, global, project);
          });
        const state = yield* Ref.make(yield* readConfig(0));

        // No fallible preparation or remote I/O belongs here. The subscriber is a local revocation
        // and publication action. The document store masks this action together with its rename.
        const commit = (next: McpResolvedConfig) =>
          Effect.gen(function* () {
            const owner = yield* Ref.get(subscriber);
            if (owner !== undefined) yield* owner.publish(next);
            yield* Ref.set(state, next);
          });
        const guardScope = (scope: McpConfigScope) =>
          scope === "project" && !options.projectTrusted
            ? Effect.fail(
                boundaryError("denied", "not-sent", "Project MCP configuration requires trust."),
              )
            : scope !== "global" && scope !== "project"
              ? Effect.fail(invalidInput())
              : Effect.void;

        const applyChange = (
          scope: McpConfigScope,
          mutate: (document: JsonObject) => Effect.Effect<JsonObject, McpBoundaryError>,
        ): Effect.Effect<McpResolvedConfig, McpBoundaryError> =>
          guardScope(scope).pipe(
            Effect.andThen(
              updates.withPermit(
                Effect.gen(function* () {
                  const modify = documents.modifyObject;
                  if (modify === undefined)
                    return yield* Effect.fail(
                      boundaryError(
                        "config",
                        "not-sent",
                        "Atomic MCP config writes are unavailable.",
                      ),
                    );
                  const current = yield* Ref.get(state);
                  const target = scope === "global" ? globalSource : projectSource;
                  const other =
                    scope === "project"
                      ? yield* readSource(globalSource)
                      : options.projectTrusted
                        ? yield* readSource(projectSource)
                        : undefined;
                  return yield* modify(
                    target.path,
                    (document) =>
                      Effect.gen(function* () {
                        const base =
                          Object.keys(document).length === 0 ? { mcpServers: {} } : document;
                        yield* decodeMcpDocument(base);
                        const nextDocument = yield* mutate(base);
                        const decoded = yield* decodeMcpDocument(nextDocument);
                        const nextSource = { ...target, document: decoded };
                        const next = yield* resolve(
                          current.revision + 1,
                          scope === "global" ? nextSource : other!,
                          scope === "project" ? nextSource : other,
                        );
                        return { document: nextDocument, value: next, afterCommit: commit(next) };
                      }),
                    readLimits,
                  ).pipe(
                    Effect.mapError((error) =>
                      error._tag === "McpBoundaryError" ? error : configError(),
                    ),
                  );
                }),
              ),
            ),
          );

        const setServer: McpConfigStoreContract["setServer"] = (scope, id, value) =>
          Effect.gen(function* () {
            yield* guardScope(scope);
            yield* Schema.decodeUnknownEffect(McpServerIdSchema)(id).pipe(
              Effect.mapError(invalidInput),
            );
            yield* decodeMcpServer(value).pipe(Effect.mapError(invalidInput));
            const entry = yield* Schema.decodeUnknownEffect(Schema.MutableJson)(value).pipe(
              Effect.mapError(invalidInput),
              Effect.flatMap((decoded) =>
                Effect.try({ try: () => freezeSnapshot(decoded), catch: invalidInput }),
              ),
            );
            return yield* applyChange(scope, (document) =>
              Effect.gen(function* () {
                const servers = yield* Schema.decodeUnknownEffect(
                  Schema.Record(Schema.String, Schema.MutableJson),
                )(document.mcpServers).pipe(Effect.mapError(configError));
                return { ...document, mcpServers: { ...servers, [id]: entry } };
              }),
            );
          });
        const removeServer: McpConfigStoreContract["removeServer"] = (scope, id) =>
          Effect.gen(function* () {
            yield* guardScope(scope);
            yield* Schema.decodeUnknownEffect(McpServerIdSchema)(id).pipe(
              Effect.mapError(invalidInput),
            );
            return yield* applyChange(scope, (document) =>
              Effect.gen(function* () {
                const servers = yield* Schema.decodeUnknownEffect(
                  Schema.Record(Schema.String, Schema.MutableJson),
                )(document.mcpServers).pipe(Effect.mapError(configError));
                const next = { ...servers };
                delete next[id];
                return { ...document, mcpServers: next };
              }),
            );
          });
        const setSettings: McpConfigStoreContract["setSettings"] = (scope, value) =>
          Effect.gen(function* () {
            yield* guardScope(scope);
            yield* checkConfigBounds(value).pipe(Effect.mapError(invalidInput));
            const patch = yield* Schema.decodeUnknownEffect(McpSettingsPatchSchema)(value, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(invalidInput));
            return yield* applyChange(scope, (document) =>
              Effect.gen(function* () {
                const previous = yield* Schema.decodeUnknownEffect(
                  Schema.Record(Schema.String, Schema.MutableJson),
                )(document.settings ?? {}).pipe(Effect.mapError(configError));
                return { ...document, settings: { ...previous, ...patch } };
              }),
            );
          });
        const reload = updates.withPermit(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const next = yield* readConfig(current.revision + 1);
            yield* commit(next).pipe(Effect.uninterruptible);
            return next;
          }),
        );
        const subscribe: McpConfigStoreContract["subscribe"] = (publish) =>
          updates.withPermit(
            Effect.gen(function* () {
              const owner: Publisher = { publish };
              yield* publish(yield* Ref.get(state));
              yield* Ref.set(subscriber, owner);
              yield* Effect.addFinalizer(() =>
                updates.withPermit(
                  Ref.update(subscriber, (current) => (current === owner ? undefined : current)),
                ),
              );
            }).pipe(Effect.uninterruptible),
          );
        return McpConfigStore.of({
          snapshot: updates.withPermit(Ref.get(state)),
          subscribe,
          reload,
          setServer,
          removeServer,
          setSettings,
        });
      }),
    );
}
