import {
  discoverOAuthProtectedResourceMetadata,
  type FetchLike,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NetworkAddresses } from "pi-cosmic-core";
import type { McpAuthChallenge } from "../auth/model.ts";
import { deniedAuth, resourceMetadataFallback, type AuthUrlPolicy } from "../auth/policy.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpOAuthConfig } from "../config/model.ts";
import { withAuthFetch } from "./auth-fetch.ts";
import { parseBearerChallenge, type BearerChallenge } from "./sdk-auth-challenge.ts";

interface ResourceDiscovery {
  readonly metadata: OAuthProtectedResourceMetadata;
  /** Absent on grants backed by discovered metadata, including existing grants. */
  readonly source?: "configured" | "origin";
  readonly challenge?: BearerChallenge | undefined;
  readonly retained: boolean;
}

/** The SDK retries other metadata candidates after broad HTTP failures; allow only absence. */
export const missingOnlyMetadataFetch =
  (fetch: FetchLike): FetchLike =>
  (url, init) =>
    fetch(url, init).then((response) => {
      if (!response.ok && response.status !== 404 && response.status !== 410)
        throw boundaryError("unavailable", "not-sent", "OAuth metadata request failed.");
      return response;
    });

/**
 * Authorization-server metadata candidates share one issuer. Like the SDK, a client error
 * or 502 on one (object stores answer 403 for missing files) moves on to the next.
 */
export const candidateMetadataFetch =
  (fetch: FetchLike): FetchLike =>
  (url, init) =>
    fetch(url, init).then((response) => {
      if (response.status >= 500 && response.status !== 502)
        throw boundaryError("unavailable", "not-sent", "OAuth metadata request failed.");
      return response;
    });

/**
 * Challenges only hint at discovery. One the strict parser rejects (ambiguous, malformed,
 * or oversized) is treated as absent, so well-known discovery on the resource's own origin
 * still runs; nothing from it is used.
 */
const challengeHint = (header: string) =>
  parseBearerChallenge(header).pipe(Effect.orElseSucceed(() => undefined));

/** A retained POST challenge wins. A failed explicit URL never grants guessed-path fallback. */
export const discoverAuthResource = (
  endpoint: string,
  resource: URL,
  config: McpOAuthConfig,
  policy: AuthUrlPolicy,
  original?: McpAuthChallenge,
): Effect.Effect<ResourceDiscovery, McpBoundaryError, NetworkAddresses> =>
  Effect.gen(function* () {
    const retained = original ? yield* challengeHint(original.wwwAuthenticate) : undefined;
    let challenge = retained;
    let rawUrl = retained?.resourceMetadata;
    if (rawUrl === undefined) {
      const response = yield* withAuthFetch(policy, (_fetch, probe) => probe(endpoint));
      const probed = yield* challengeHint(response.headers.get("www-authenticate") ?? "");
      rawUrl = probed?.resourceMetadata;
      // A GET can supply a missing metadata URL, but cannot donate scope/error fields
      // to the original rejection. Empty or realm-only evidence has no such authority.
      if (retained?.scope === undefined && retained?.error === undefined) challenge = probed;
    }
    const evidence = { retained: retained !== undefined && challenge === retained, challenge };
    let rawMetadata: string | undefined;
    const result = yield* withAuthFetch(policy, (fetch) => {
      const metadataFetch = missingOnlyMetadataFetch(fetch);
      let responses = 0;
      let allMissing = true;
      let rejected = false;
      // Keep the raw hint for destination checks before URL construction can erase bad syntax.
      return discoverOAuthProtectedResourceMetadata(
        endpoint,
        rawUrl === undefined ? undefined : { resourceMetadataUrl: rawUrl },
        (url, init) =>
          metadataFetch(rawUrl ?? url, init).then(
            (response) => {
              responses++;
              allMissing &&= response.status === 404 || response.status === 410;
              // The SDK URL codec can normalize text. Retain raw binding spellings so
              // application validation sees whitespace, path, query, and issuer pins intact.
              if (response.ok)
                return response
                  .clone()
                  .text()
                  .then((text) => {
                    rawMetadata = text;
                    return response;
                  });
              return response;
            },
            () => {
              rejected = true;
              throw boundaryError(
                "unavailable",
                "not-sent",
                "OAuth protected-resource request failed.",
              );
            },
          ),
      ).then(
        (metadata) => ({ status: "found", metadata }) as const,
        () =>
          ({
            status:
              rawUrl === undefined && responses > 0 && allMissing && !rejected
                ? "missing"
                : "invalid",
          }) as const,
      );
    });
    // withAuthFetch's sticky policy/network failure wins before compatibility is considered.
    if (result.status === "found") {
      if (rawMetadata === undefined) return yield* deniedAuth();
      const bindings = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            resource: Schema.String,
            authorization_servers: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      )(rawMetadata).pipe(Effect.mapError(deniedAuth));
      return {
        metadata: {
          ...result.metadata,
          resource: bindings.resource,
          authorization_servers: bindings.authorization_servers
            ? [...bindings.authorization_servers]
            : undefined,
        },
        ...evidence,
      } satisfies ResourceDiscovery;
    }
    if (result.status === "missing") {
      const fallback = yield* resourceMetadataFallback(endpoint, config);
      if (fallback)
        return {
          metadata: { resource: resource.href, authorization_servers: [fallback.issuer] },
          source: fallback.source,
          ...evidence,
        } satisfies ResourceDiscovery;
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "OAuth protected-resource metadata is missing and the configured policy does not permit fallback.",
        "oauth-resource-metadata-missing",
      );
    }
    return yield* boundaryError(
      "unavailable",
      "not-sent",
      "OAuth protected-resource discovery failed; missing-metadata compatibility was not used.",
      "oauth-resource-metadata-invalid",
    );
  });
