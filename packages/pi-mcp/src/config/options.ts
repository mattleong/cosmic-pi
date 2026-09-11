import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";
import type {
  McpConfigScope,
  McpEffectiveServer,
  McpResolvedConfig,
  McpServerDefinition,
  McpSettings,
} from "./model.ts";
import {
  DEFAULT_MCP_SETTINGS,
  decodeMcpServer,
  McpServerIdSchema,
  McpSettingsPatchSchema,
  McpSettingsSchema,
  type McpDecodedDocument,
  type McpRawEnabledServer,
} from "./schema.ts";

export interface McpConfigSource {
  readonly scope: McpConfigScope;
  readonly path: string;
  readonly directory: string;
  readonly document?: McpDecodedDocument;
  readonly diagnostic?: string;
}

/** Environment and header values stay unresolved. The owning directory, not the current process cwd, owns relative paths. */
export function normalizeMcpServer(
  raw: McpRawEnabledServer,
  directory: string,
  path: Path.Path,
): McpServerDefinition {
  const policy: Pick<McpServerDefinition, "allowTools" | "denyTools"> = {
    denyTools: [...new Set(raw.denyTools ?? [])].sort(),
  };
  const resolvedPolicy =
    raw.allowTools === undefined
      ? policy
      : { ...policy, allowTools: [...new Set(raw.allowTools)].sort() };
  if ("command" in raw)
    return {
      ...resolvedPolicy,
      transport: "stdio",
      command: raw.command,
      args: raw.args ?? [],
      cwd: path.resolve(directory, raw.cwd ?? "."),
      environment: raw.env ?? {},
    };
  const auth =
    raw.auth === false ? { type: "none" as const } : (raw.auth ?? { type: "none" as const });
  const definition: McpServerDefinition = {
    ...resolvedPolicy,
    transport: "http",
    url: new URL(raw.url).href,
    headers: Object.fromEntries(
      Object.entries(raw.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    ),
    auth:
      raw.auth === undefined && Object.keys(raw.headers ?? {}).length === 0
        ? { type: "oauth", implicit: true, registration: "dynamic", scopes: [] }
        : auth.type === "oauth"
          ? {
              ...auth,
              registration:
                auth.registration ??
                (auth.clientId !== undefined
                  ? "pre-registered"
                  : auth.clientMetadataUrl !== undefined
                    ? "metadata"
                    : "dynamic"),
              scopes: [...new Set(auth.scopes ?? [])].sort(),
            }
          : auth,
  };
  if (auth.type === "oauth" && auth.scopes?.length === 0)
    Object.assign(definition.auth, { explicitEmptyScopes: true });
  return definition;
}

const decodeSettings = (value: McpDecodedDocument["settings"]) =>
  Effect.gen(function* () {
    const accepted: Record<string, Schema.Json> = {};
    let invalid = false;
    for (const [key, codec] of Object.entries(McpSettingsSchema.fields)) {
      if (value === undefined || !Object.hasOwn(value, key)) continue;
      const result = yield* Schema.decodeUnknownEffect(codec)(value[key]).pipe(Effect.result);
      if (result._tag === "Failure") invalid = true;
      else accepted[key] = value[key]!;
    }
    const settings = yield* Schema.decodeUnknownEffect(McpSettingsPatchSchema)(accepted).pipe(
      Effect.mapError(() =>
        boundaryError("config", "not-sent", "Invalid MCP settings configuration."),
      ),
    );
    return { settings, invalid };
  });

/** Stable key ordering makes identity independent of JSON formatting and object insertion order. */
const identityInput = (source: McpConfigSource, server: McpEffectiveServer): string =>
  JSON.stringify({ scope: source.scope, path: source.path, server }, (_key, item: Schema.Json) =>
    Predicate.isObject(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );

export const resolveMcpConfig = (options: {
  readonly revision: number;
  readonly trusted: boolean;
  readonly global: McpConfigSource;
  readonly projectRoot?: McpConfigSource | undefined;
  readonly project?: McpConfigSource | undefined;
  readonly path: Path.Path;
}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sources = [options.global, options.projectRoot, options.project].filter(
      (source) => source !== undefined,
    );
    let settings: McpSettings = { ...DEFAULT_MCP_SETTINGS };
    let invalidSettings = false;
    const diagnostics: string[] = [];
    const entries = new Map<string, { source: McpConfigSource; value: Schema.Json }>();
    for (const source of sources) {
      const decoded = yield* decodeSettings(source.document?.settings);
      settings = { ...settings, ...decoded.settings };
      invalidSettings ||= decoded.invalid;
      if (source.diagnostic !== undefined) diagnostics.push(source.diagnostic);
      for (const [id, value] of Object.entries(source.document?.mcpServers ?? {}))
        entries.set(id, { source, value });
    }
    if (invalidSettings) diagnostics.push("Some MCP settings were ignored.");
    const servers: Record<string, McpEffectiveServer> = {};
    const projectBlocked = sources.some(
      (source) => source.scope === "project" && source.diagnostic !== undefined,
    );
    let invalidEntries = false;
    for (const [id, { source, value }] of entries) {
      if (!Schema.is(McpServerIdSchema)(id)) {
        invalidEntries = true;
        continue;
      }
      const decoded = yield* decodeMcpServer(value).pipe(Effect.result);
      const raw = decoded._tag === "Success" ? decoded.success : undefined;
      const definition =
        raw === undefined || raw.enabled === false
          ? undefined
          : normalizeMcpServer(raw, source.directory, options.path);
      const diagnostic = projectBlocked
        ? "Project MCP configuration is unavailable; execution is disabled."
        : decoded._tag === "Failure"
          ? `${decoded.failure.message} Execution is disabled.`
          : undefined;
      if (decoded._tag === "Failure") invalidEntries = true;
      const enabled = diagnostic === undefined && definition !== undefined;
      let server: McpEffectiveServer = {
        id,
        scope: source.scope,
        directory: source.directory,
        identity: "",
        enabled,
      };
      if (definition !== undefined) server = { ...server, definition };
      if (diagnostic !== undefined) server = { ...server, diagnostic };
      const input = yield* Effect.try({
        try: () => identityInput(source, server),
        catch: () => boundaryError("config", "not-sent", "Unable to identify MCP configuration."),
      });
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input))
        .pipe(
          Effect.mapError(() =>
            boundaryError("config", "not-sent", "Unable to identify MCP configuration."),
          ),
        );
      Object.defineProperty(servers, id, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          ...server,
          identity: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        } satisfies McpEffectiveServer,
      });
    }
    if (invalidEntries) diagnostics.push("Some MCP server entries were disabled or ignored.");
    return {
      revision: options.revision,
      trusted: options.trusted,
      settings,
      servers,
      diagnostics,
    } satisfies McpResolvedConfig;
  });
