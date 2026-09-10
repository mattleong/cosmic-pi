import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { FetchHttpClient } from "effect/unstable/http";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpConnection } from "../client/model.ts";
import type { McpBindingValue, McpEffectiveServer, McpSettings } from "../config/model.ts";
import { openSdkHttp, type SdkHttpOptions } from "./sdk-http.ts";
import { openSdkStdio } from "./sdk-stdio.ts";

export interface McpConnectorContract {
  readonly open: (
    server: McpEffectiveServer,
    settings: McpSettings,
    token?: string,
  ) => Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope>;
}

// Only admission evidence survives runtime replacement, never a connection or runtime.
// A failed cleanup retains its entry until process restart. The owning directory and
// server id, not the replaceable config identity, prevent endpoint changes bypassing it.
const acquisitions = new Map<string, object>();
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const configFailure = () =>
  boundaryError("config", "not-sent", "MCP environment binding is unavailable.");

const resolveBindings = (
  bindings: Readonly<Record<string, McpBindingValue>>,
  provider: ConfigProvider.ConfigProvider,
) =>
  Effect.gen(function* () {
    const resolved: Record<string, string> = {};
    for (const [key, binding] of Object.entries(bindings)) {
      resolved[key] =
        "value" in binding
          ? binding.value
          : yield* Config.string(binding.env).parse(provider).pipe(Effect.mapError(configFailure));
    }
    return resolved;
  });

export class McpConnector extends Context.Service<McpConnector, McpConnectorContract>()(
  "pi-mcp/boundary/sdk-connection/McpConnector",
) {
  static readonly layer = Layer.effect(
    McpConnector,
    Effect.gen(function* () {
      // Capture builtin capabilities once, but resolve secret bindings only at open.
      const provider = yield* ConfigProvider.ConfigProvider;
      const nativeFetch = yield* FetchHttpClient.Fetch;
      const path = yield* Path.Path;
      const open: McpConnectorContract["open"] = (server, settings, token) =>
        Effect.gen(function* () {
          if (!settings.enabled || !server.enabled || server.definition === undefined) {
            return yield* Effect.fail(
              boundaryError("denied", "not-sent", "MCP server is disabled."),
            );
          }
          const definition = server.definition;
          const common = {
            connectTimeoutMs: settings.connectTimeoutMs,
            requestTimeoutMs: settings.requestTimeoutMs,
          };
          const options =
            definition.transport === "stdio"
              ? {
                  transport: "stdio" as const,
                  command: definition.command,
                  args: definition.args,
                  cwd: path.resolve(server.directory, definition.cwd ?? "."),
                  environment: {
                    // PATH alone is sufficient for executable lookup. HOME and TMPDIR must
                    // be explicit bindings; no Pi credentials or other parent env is copied.
                    PATH: yield* Config.string("PATH")
                      .pipe(Config.withDefault(DEFAULT_PATH))
                      .parse(provider)
                      .pipe(Effect.mapError(configFailure)),
                    ...(yield* resolveBindings(definition.environment, provider)),
                  },
                }
              : {
                  transport: "http" as const,
                  url: yield* Effect.try({
                    try: () => new URL(definition.url),
                    catch: () => boundaryError("config", "not-sent", "Invalid MCP endpoint."),
                  }),
                  headers: yield* resolveBindings(definition.headers, provider),
                  token:
                    token ??
                    (definition.auth.type === "env"
                      ? yield* Config.string(definition.auth.env)
                          .parse(provider)
                          .pipe(Effect.mapError(configFailure))
                      : undefined),
                };
          return yield* Effect.uninterruptibleMask((restore) => {
            const directory = path.resolve(server.directory);
            const key = `${directory.length}:${directory}${server.id}`;
            if (acquisitions.has(key)) {
              return Effect.fail(
                boundaryError(
                  "cleanup",
                  "not-sent",
                  "MCP server still has an active or unconfirmed connection.",
                ),
              );
            }
            const owner = {};
            acquisitions.set(key, owner);
            let observed = false;
            const onCleanup = (confirmed: boolean): void => {
              observed = true;
              if (confirmed && acquisitions.get(key) === owner) acquisitions.delete(key);
            };
            let acquired: Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope>;
            if (options.transport === "stdio") {
              acquired = openSdkStdio({ ...common, ...options, onCleanup });
            } else {
              const httpOptions: SdkHttpOptions = {
                ...common,
                url: options.url,
                headers: options.headers,
                onCleanup,
              };
              acquired = openSdkHttp(
                options.token === undefined
                  ? httpOptions
                  : { ...httpOptions, token: options.token },
              ).pipe(Effect.provideService(FetchHttpClient.Fetch, nativeFetch));
            }
            return restore(acquired).pipe(
              Effect.onExit((exit) => {
                // Both boundaries mask cleanup installation before all native acquisition.
                // A failed entry without an observer therefore never reached ownership,
                // including interruption before the boundary's first instruction.
                if (Exit.isFailure(exit) && !observed) return Effect.sync(() => onCleanup(true));
                return Effect.void;
              }),
            );
          });
        });
      return { open };
    }),
  ).pipe(Layer.provide(Path.layer));
}
