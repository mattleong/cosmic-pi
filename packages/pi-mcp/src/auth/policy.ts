import * as Effect from "effect/Effect";
import { hasControlCharacter, type NetworkAddress } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import type { McpEffectiveServer, McpOAuthConfig } from "../config/model.ts";

export const authFailure = () =>
  boundaryError("auth-required", "not-sent", "MCP authentication is required.");
export const deniedAuth = () =>
  boundaryError(
    "denied",
    "not-sent",
    "OAuth destination or binding was rejected.",
    "oauth-binding-rejected",
  );
export const oauthConfig = (server: McpEffectiveServer): McpOAuthConfig | undefined =>
  server.enabled &&
  server.definition?.transport === "http" &&
  server.definition.auth.type === "oauth"
    ? server.definition.auth
    : undefined;

export interface AuthUrlPolicy {
  readonly privateOrigins: ReadonlySet<string>;
  readonly localHttpOrigins: ReadonlySet<string>;
}
export const isLoopbackHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]";
export const parseAuthUrl = (value: string) =>
  Effect.try({
    try: () => {
      if (
        value.length > 8192 ||
        hasControlCharacter(value) ||
        /\s/.test(value) ||
        value.includes("#") ||
        value.includes("\\") ||
        value
          .slice(value.indexOf("//") + 2)
          .split(/[/?]/)[0]
          ?.includes("@")
      )
        throw deniedAuth();
      const url = new URL(value);
      if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol))
        throw deniedAuth();
      return url;
    },
    catch: () => deniedAuth(),
  });
/** Missing metadata may use only the resource server's origin unless explicitly pinned. */
export const resourceMetadataFallback = (endpoint: string, config: McpOAuthConfig) =>
  Effect.gen(function* () {
    if (config.allowMissingResourceMetadata === false) return undefined;
    const server = yield* parseAuthUrl(endpoint);
    if (config.issuer !== undefined) {
      yield* parseAuthUrl(config.issuer);
      return { issuer: config.issuer, source: "configured" as const };
    }
    return { issuer: server.origin, source: "origin" as const };
  });

export const authUrlPolicy = (server: McpEffectiveServer) =>
  Effect.gen(function* () {
    if (server.definition?.transport !== "http") return yield* authFailure();
    const config = oauthConfig(server);
    if (!config) return yield* authFailure();
    const explicit = yield* Effect.forEach(
      [server.definition.url, ...(config.issuer ? [config.issuer] : [])],
      parseAuthUrl,
    );
    if (explicit.some((url) => url.protocol === "http:" && !isLoopbackHost(url.hostname)))
      return yield* deniedAuth();
    return {
      privateOrigins: new Set(explicit.map((url) => url.origin)),
      localHttpOrigins: new Set(
        explicit.filter((url) => url.protocol === "http:").map((url) => url.origin),
      ),
    } satisfies AuthUrlPolicy;
  });
export const validateAuthUrl = (value: string, policy: AuthUrlPolicy) =>
  parseAuthUrl(value).pipe(
    Effect.flatMap((url) =>
      url.protocol === "https:" || policy.localHttpOrigins.has(url.origin)
        ? Effect.succeed(url)
        : Effect.fail(deniedAuth()),
    ),
  );

/** Fail closed on non-global ranges, including mapped IPv4 and transition IPv6. */
export const isPublicAddress = ({ address, family }: NetworkAddress): boolean => {
  if (family === 4) {
    const bytes = address.split(".").map(Number);
    if (bytes.length !== 4 || bytes.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
      return false;
    const [a, b, c] = bytes;
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a! < 224 &&
      !(a === 100 && b! >= 64 && b! <= 127) &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
      !(a === 203 && b === 0 && c === 113)
    );
  }
  const lower = address.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lower)) return false;
  const first = Number.parseInt(lower.split(":")[0] ?? "", 16);
  const second = Number.parseInt(lower.split(":")[1] || "0", 16);
  // Global unicast only. Deny special-purpose 2001::/23, documentation and 6to4.
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2002 &&
    first !== 0x3fff &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
  );
};
export const validateAuthAddresses = (
  url: URL,
  addresses: ReadonlyArray<NetworkAddress>,
  policy: AuthUrlPolicy,
) =>
  addresses.length > 0 &&
  addresses.length <= 64 &&
  (policy.privateOrigins.has(url.origin) || addresses.every(isPublicAddress))
    ? Effect.void
    : Effect.fail(deniedAuth());

export const callbackRedirect = (configured?: string) =>
  parseAuthUrl(configured ?? "http://127.0.0.1:0/callback").pipe(
    Effect.flatMap((url) =>
      url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.search
        ? Effect.succeed(url)
        : Effect.fail(
            boundaryError(
              "unsupported",
              "not-sent",
              "OAuth requires a registered IPv4 loopback callback.",
            ),
          ),
    ),
  );

/** The attempt is consumed even when malformed, so no callback can be redeemed twice. */
export const singleUseCallback = (redirect: string, state: string) => {
  let used = false;
  return (value: string) =>
    Effect.suspend(() => {
      if (used) return Effect.fail(deniedAuth());
      used = true;
      return parseAuthUrl(value).pipe(
        Effect.flatMap((url) => {
          const base = new URL(redirect);
          const keys = [...url.searchParams.keys()];
          if (
            url.origin !== base.origin ||
            url.pathname !== base.pathname ||
            new Set(keys).size !== keys.length ||
            url.searchParams.get("state") !== state ||
            url.searchParams.has("error") ||
            !url.searchParams.get("code") ||
            url.searchParams.has("access_token")
          )
            return Effect.fail(deniedAuth());
          return Effect.succeed({
            code: url.searchParams.get("code")!,
            iss: url.searchParams.get("iss") ?? undefined,
          });
        }),
      );
    });
};
