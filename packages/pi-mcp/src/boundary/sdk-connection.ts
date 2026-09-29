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
import type { McpEffectiveServer, McpSettings } from "../config/model.ts";
import { openSdkHttp, type SdkHttpOptions } from "./sdk-http.ts";
import { openSdkStdio, type SdkStdioOptions } from "./sdk-stdio.ts";
import type { StdioEraVerdict } from "./mcp-protocol/shared/stdio-negotiation.ts";
import { observeSdkCleanup } from "./sdk-events.ts";
import { requireSecureBearerDestination } from "../auth/policy.ts";

export interface McpConnectorContract {
  readonly open: (
    server: McpEffectiveServer,
    settings: McpSettings,
    token?: string,
    /** Reports cleanup during acquisition or later scope finalization. */
    onCleanup?: (confirmed: boolean) => void,
  ) => Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope>;
}

// Only admission evidence survives runtime replacement, never a connection or runtime.
// A failed cleanup retains its entry until process restart. The owning directory and
// server id, not the replaceable config identity, prevent endpoint changes bypassing it.
const acquisitions = new Map<string, object>();
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const configFailure = () =>
  boundaryError("config", "not-sent", "MCP configuration value is unavailable or invalid.");

const resolveInterpolatedValue = (
  value: string,
  provider: ConfigProvider.ConfigProvider,
  header: boolean,
) =>
  Effect.gen(function* () {
    const pattern = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let resolved = "";
    let offset = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      resolved += value.slice(offset, match.index);
      resolved +=
        match[0] === "$$"
          ? "$"
          : yield* Config.string(match[1]!).parse(provider).pipe(Effect.mapError(configFailure));
      if (resolved.length > 8_192) return yield* Effect.fail(configFailure());
      offset = match.index + match[0].length;
    }
    resolved += value.slice(offset);
    if (resolved.length > 8_192 || resolved.includes("\0") || (header && /[\r\n]/.test(resolved)))
      return yield* Effect.fail(configFailure());
    return resolved;
  });

const resolveInterpolatedValues = (
  values: Readonly<Record<string, string>>,
  provider: ConfigProvider.ConfigProvider,
  header: boolean,
) =>
  Effect.gen(function* () {
    const resolved: Array<readonly [string, string]> = [];
    for (const [key, value] of Object.entries(values))
      resolved.push([key, yield* resolveInterpolatedValue(value, provider, header)]);
    return Object.fromEntries(resolved);
  });

export class McpConnector extends Context.Service<McpConnector, McpConnectorContract>()(
  "pi-mcp/boundary/sdk-connection/McpConnector",
) {
  static readonly layer = Layer.effect(
    McpConnector,
    Effect.gen(function* () {
      // Capture builtin capabilities once, but resolve environment values only at open.
      const provider = yield* ConfigProvider.ConfigProvider;
      const nativeFetch = yield* FetchHttpClient.Fetch;
      const path = yield* Path.Path;
      // Session-local stdio era verdicts by exact definition identity. Any failed
      // acquisition forgets its verdict, so the next attempt probes again.
      const verdicts = new Map<string, StdioEraVerdict>();
      const open: McpConnectorContract["open"] = (server, settings, token, observer) =>
        Effect.gen(function* () {
          if (!settings.enabled || !server.enabled || server.definition === undefined) {
            return yield* Effect.fail(
              boundaryError("denied", "not-sent", "MCP server is disabled."),
            );
          }
          const definition = server.definition;
          // Reject plaintext destinations before reading managed environment credentials.
          if (
            definition.transport === "http" &&
            (token !== undefined || definition.auth.type === "env")
          )
            yield* requireSecureBearerDestination(definition.url);
          const common = {
            protocol: definition.protocol ?? "auto",
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
                    // be explicit entries; no Pi credentials or other parent env is copied.
                    PATH: yield* Config.string("PATH")
                      .pipe(Config.withDefault(DEFAULT_PATH))
                      .parse(provider)
                      .pipe(Effect.mapError(configFailure)),
                    ...(yield* resolveInterpolatedValues(definition.environment, provider, false)),
                  },
                }
              : {
                  transport: "http" as const,
                  url: yield* Effect.try({
                    try: () => new URL(definition.url),
                    catch: () => boundaryError("config", "not-sent", "Invalid MCP endpoint."),
                  }),
                  headers: yield* resolveInterpolatedValues(definition.headers, provider, true),
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
              observeSdkCleanup(observer, confirmed);
            };
            let acquired: Effect.Effect<McpConnection, McpBoundaryError, Scope.Scope>;
            if (options.transport === "stdio") {
              const stdioOptions: SdkStdioOptions = {
                ...common,
                ...options,
                onCleanup,
                onNegotiated: (verdict) => verdicts.set(server.identity, verdict),
              };
              const remembered = verdicts.get(server.identity);
              acquired = openSdkStdio(
                remembered === undefined ? stdioOptions : { ...stdioOptions, remembered },
              ).pipe(Effect.tapError(() => Effect.sync(() => verdicts.delete(server.identity))));
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
