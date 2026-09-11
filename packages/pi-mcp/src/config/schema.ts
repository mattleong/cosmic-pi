import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";
import { oauthScopes } from "../auth/scopes.ts";
import type { McpSettings } from "./model.ts";

export const MCP_CONFIG_BASENAME = "pi-mcp.json";
export const MCP_PROJECT_CONFIG_BASENAME = ".mcp.json";
export const MCP_CONFIG_LIMITS = Object.freeze({
  bytes: 1_048_576,
  nodes: 32_768,
  depth: 16,
  servers: 256,
  entryBytes: 65_536,
});

const integer = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const text = (maximum: number, minimum = 1) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const noNulText = (maximum: number, minimum = 1) =>
  text(maximum, minimum).check(Schema.isPattern(/^[^\0]*$/));
const envName = text(256).check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const headerName = text(256).check(Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/));
const names = Schema.Array(noNulText(256)).check(Schema.isMaxLength(512));
const endpoint = text(8_192).check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }),
);

export const McpServerIdSchema = text(128).check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/));
export const McpSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  connectTimeoutMs: integer(1, 600_000),
  requestTimeoutMs: integer(1, 3_600_000),
  idleTimeoutMs: integer(1, 86_400_000),
  maxConcurrent: integer(1, 128),
  maxPerServer: integer(1, 128),
  maxQueued: integer(0, 4_096),
});
export const McpSettingsPatchSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  connectTimeoutMs: Schema.optionalKey(McpSettingsSchema.fields.connectTimeoutMs),
  requestTimeoutMs: Schema.optionalKey(McpSettingsSchema.fields.requestTimeoutMs),
  idleTimeoutMs: Schema.optionalKey(McpSettingsSchema.fields.idleTimeoutMs),
  maxConcurrent: Schema.optionalKey(McpSettingsSchema.fields.maxConcurrent),
  maxPerServer: Schema.optionalKey(McpSettingsSchema.fields.maxPerServer),
  maxQueued: Schema.optionalKey(McpSettingsSchema.fields.maxQueued),
});
export const DEFAULT_MCP_SETTINGS: McpSettings = Object.freeze({
  enabled: true,
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 600_000,
  maxConcurrent: 8,
  maxPerServer: 4,
  maxQueued: 64,
});

const environment = Schema.Record(envName, noNulText(8_192, 0)).check(Schema.isMaxProperties(128));
const headers = Schema.Record(
  headerName,
  text(8_192, 0).check(Schema.isPattern(/^[^\r\n\0]*$/)),
).check(
  Schema.isMaxProperties(128),
  Schema.makeFilter((value) => {
    const keys = Object.keys(value).map((key) => key.toLowerCase());
    return new Set(keys).size === keys.length;
  }),
);
const oauth = Schema.Struct({
  type: Schema.Literal("oauth"),
  registration: Schema.optionalKey(Schema.Literals(["pre-registered", "dynamic", "metadata"])),
  clientId: Schema.optionalKey(noNulText(2_048)),
  clientMetadataUrl: Schema.optionalKey(endpoint),
  issuer: Schema.optionalKey(endpoint),
  allowMissingResourceMetadata: Schema.optionalKey(Schema.Boolean),
  resource: Schema.optionalKey(endpoint),
  scopes: Schema.optionalKey(oauthScopes),
  redirectUri: Schema.optionalKey(endpoint),
}).check(
  Schema.makeFilter((value) => {
    const registration =
      value.registration ??
      (value.clientId !== undefined
        ? "pre-registered"
        : value.clientMetadataUrl !== undefined
          ? "metadata"
          : "dynamic");
    if (value.clientId !== undefined && value.clientMetadataUrl !== undefined) return false;
    if (registration === "pre-registered") return value.clientId !== undefined;
    if (registration === "metadata") return value.clientMetadataUrl !== undefined;
    return value.clientId === undefined && value.clientMetadataUrl === undefined;
  }),
);
const auth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({ type: Schema.Literal("env"), env: envName }),
  oauth,
]);
const policy = {
  enabled: Schema.optionalKey(Schema.Literal(true)),
  allowTools: Schema.optionalKey(names),
  denyTools: Schema.optionalKey(names),
};
const stdioServer = Schema.Struct({
  ...policy,
  type: Schema.optionalKey(Schema.Literal("stdio")),
  command: noNulText(8_192),
  args: Schema.optionalKey(Schema.Array(noNulText(8_192, 0)).check(Schema.isMaxLength(256))),
  cwd: Schema.optionalKey(noNulText(8_192)),
  env: Schema.optionalKey(environment),
});
const httpServer = Schema.Struct({
  ...policy,
  type: Schema.optionalKey(Schema.Literal("http")),
  url: endpoint,
  headers: Schema.optionalKey(headers),
  auth: Schema.optionalKey(Schema.Union([auth, Schema.Literal(false)])),
});
export const McpEnabledServerSchema = Schema.Union([stdioServer, httpServer]);
export type McpRawEnabledServer = typeof McpEnabledServerSchema.Type;
export const McpDisabledServerSchema = Schema.Struct({ enabled: Schema.Literal(false) });

const mcpServers = Schema.Record(Schema.String, Schema.Json).check(
  Schema.isMaxProperties(MCP_CONFIG_LIMITS.servers),
);
export const McpDocumentSchema = Schema.StructWithRest(
  Schema.Struct({
    mcpServers,
    settings: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
).check(
  Schema.makeFilter(
    (value) => !Object.hasOwn(value, "version") && !Object.hasOwn(value, "servers"),
  ),
);
export type McpDecodedDocument = typeof McpDocumentSchema.Type;

const isConfigContainer = (value: Schema.Json): value is Schema.JsonArray | Schema.JsonObject =>
  Predicate.isObjectOrArray(value);
const encodedStringBytes = (value: string) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Bound traversal before invoking recursive codecs. Core has already decoded document JSON. */
export const checkConfigBounds = (
  value: Schema.Json,
  byteLimit: number = MCP_CONFIG_LIMITS.bytes,
) =>
  Effect.try({
    try: () => {
      let nodes = 0;
      let bytes = 0;
      const pending = [{ value, depth: 0 }];
      while (pending.length > 0) {
        const entry = pending.pop()!;
        nodes++;
        if (nodes > MCP_CONFIG_LIMITS.nodes || entry.depth > MCP_CONFIG_LIMITS.depth)
          throw new Error("bounds");
        const item = entry.value;
        if (Predicate.isString(item)) {
          if (item.length > byteLimit) throw new Error("bounds");
          bytes += encodedStringBytes(item);
        } else if (isConfigContainer(item)) {
          const children = Object.entries<Schema.Json>(item);
          if (children.length > MCP_CONFIG_LIMITS.nodes) throw new Error("bounds");
          bytes += 2;
          for (const [key, child] of children) {
            if (key.length > byteLimit) throw new Error("bounds");
            bytes += encodedStringBytes(key) + 2;
            pending.push({ value: child, depth: entry.depth + 1 });
          }
        } else bytes += String(item).length + 1;
        if (bytes > byteLimit) throw new Error("bounds");
      }
    },
    catch: () => boundaryError("config", "not-sent", "MCP configuration exceeds its limits."),
  });

export const decodeMcpDocument = (value: Schema.Json) =>
  checkConfigBounds(value).pipe(
    Effect.andThen(Schema.decodeUnknownEffect(McpDocumentSchema)(value)),
    Effect.mapError(() =>
      boundaryError("config", "not-sent", "Invalid or unsupported MCP configuration document."),
    ),
  );

const serverFieldHints = new Map(
  Object.entries({
    enabled: '"enabled": expected a boolean.',
    allowTools: '"allowTools": expected an array of tool-name strings.',
    denyTools: '"denyTools": expected an array of tool-name strings.',
    command: '"command": expected a nonempty executable string without NUL characters.',
    args: '"args": expected an array of argument strings without NUL characters.',
    cwd: '"cwd": expected a nonempty directory string without NUL characters.',
    env: '"env": expected valid environment-variable names mapped to string values.',
    url: '"url": expected an HTTP or HTTPS URL without embedded credentials or a fragment.',
    headers:
      '"headers": expected unique case-insensitive HTTP header names mapped to strings without CR, LF, or NUL.',
    auth: '"auth": use false to disable managed authentication, or an object with type "none", "env", or "oauth" and its supported fields. Omission enables implicit OAuth only without custom headers. Boolean true is not supported.',
  }),
);

/** Runs only after bounded strict validation fails. Never format raw schema issues or input. */
const invalidServerDiagnostic = (value: Schema.Json) =>
  Effect.gen(function* () {
    if (!Predicate.isObject(value) || Array.isArray(value))
      return "Expected a server configuration object.";
    const http = Object.hasOwn(value, "url");
    if (http === Object.hasOwn(value, "command"))
      return 'Provide exactly one of "command" for stdio or "url" for HTTP.';
    const fields = http ? httpServer.fields : stdioServer.fields;
    for (const field of Object.keys(value)) {
      if (Object.hasOwn(fields, field)) continue;
      if (field === "transport")
        return '"transport" is unsupported. Use "type": "stdio" or "http", or omit it.';
      if (field === "environment")
        return '"environment" is unsupported. Use "env" with string values for stdio servers.';
      // Arbitrary property names can contain secrets, so only known legacy names are exposed.
      return http
        ? "Unsupported HTTP server field. Allowed fields: type, url, headers, auth, enabled, allowTools, denyTools."
        : "Unsupported stdio server field. Allowed fields: type, command, args, cwd, env, enabled, allowTools, denyTools.";
    }
    for (const [field, codec] of Object.entries<Schema.Decoder<unknown>>(fields)) {
      if (!Object.hasOwn(value, field)) continue;
      const result = yield* Schema.decodeUnknownEffect(codec)(value[field], {
        onExcessProperty: "error",
      }).pipe(Effect.result);
      if (result._tag === "Failure")
        return field === "type"
          ? http
            ? '"type": expected "http" for a URL server.'
            : '"type": expected "stdio" for a command server.'
          : (serverFieldHints.get(field) ?? "Invalid MCP server configuration.");
    }
    return "Invalid MCP server configuration.";
  });

export const decodeMcpServer = (value: Schema.Json) =>
  checkConfigBounds(value, MCP_CONFIG_LIMITS.entryBytes).pipe(
    Effect.andThen(
      Schema.decodeUnknownEffect(McpDisabledServerSchema)(value).pipe(
        Effect.catch(() =>
          Schema.decodeUnknownEffect(McpEnabledServerSchema)(value, {
            onExcessProperty: "error",
          }).pipe(
            Effect.catch(() =>
              invalidServerDiagnostic(value).pipe(
                Effect.flatMap((message) =>
                  Effect.fail(boundaryError("config", "not-sent", message)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
