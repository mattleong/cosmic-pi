import {
  discoverOAuthProtectedResourceMetadata,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import type { AuthUrlPolicy } from "../auth/policy.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpOAuthConfig } from "../config/model.ts";
import { withAuthFetch } from "./auth-fetch.ts";

interface ResourceDiscovery {
  readonly metadata: OAuthProtectedResourceMetadata;
  /** Absent on grants backed by discovered metadata, including existing grants. */
  readonly source?: "configured";
}

/** Only explicit absence permits configured bindings; SDK exception text is never inspected. */
export const discoverAuthResource = (
  endpoint: string,
  resource: URL,
  config: McpOAuthConfig,
  policy: AuthUrlPolicy,
) =>
  withAuthFetch(policy, (fetch) => {
    let responses = 0;
    let allMissing = true;
    let rejected = false;
    // The SDK requires Promise callbacks. Their work remains owned by withAuthFetch.
    return discoverOAuthProtectedResourceMetadata(endpoint, undefined, (url, init) =>
      fetch(url, init).then(
        (response) => {
          responses++;
          allMissing &&= response.status === 404 || response.status === 410;
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
      () => ({ status: responses > 0 && allMissing && !rejected ? "missing" : "invalid" }) as const,
    );
  }).pipe(
    // withAuthFetch's sticky policy/network failure wins before compatibility is considered.
    Effect.flatMap((result): Effect.Effect<ResourceDiscovery, McpBoundaryError> => {
      if (result.status === "found") return Effect.succeed({ metadata: result.metadata });
      if (result.status === "missing") {
        if (config.allowMissingResourceMetadata === true && config.issuer !== undefined)
          return Effect.succeed({
            metadata: { resource: resource.href, authorization_servers: [config.issuer] },
            source: "configured",
          });
        return Effect.fail(
          boundaryError(
            "unsupported",
            "not-sent",
            "OAuth protected-resource metadata is missing; explicit compatibility configuration is required.",
            "oauth-resource-metadata-missing",
          ),
        );
      }
      return Effect.fail(
        boundaryError(
          "unavailable",
          "not-sent",
          "OAuth protected-resource discovery failed; missing-metadata compatibility was not used.",
          "oauth-resource-metadata-invalid",
        ),
      );
    }),
  );
