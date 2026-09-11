import {
  discoverOAuthProtectedResourceMetadata,
  type FetchLike,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import { resourceMetadataFallback, type AuthUrlPolicy } from "../auth/policy.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpOAuthConfig } from "../config/model.ts";
import { withAuthFetch } from "./auth-fetch.ts";

interface ResourceDiscovery {
  readonly metadata: OAuthProtectedResourceMetadata;
  /** Absent on grants backed by discovered metadata, including existing grants. */
  readonly source?: "configured" | "origin";
}

type MetadataHint =
  | { readonly status: "invalid" }
  | { readonly status: "parsed"; readonly url: string | undefined };

/** Split challenges without treating commas or scheme names inside quoted values as syntax. */
const resourceMetadataHint = (header: string): MetadataHint => {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") {
      parts.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) return { status: "invalid" };
  parts.push(header.slice(start).trim());
  let scheme: string | undefined;
  let url: string | undefined;
  for (const part of parts) {
    if (!part) continue;
    let parameter = part;
    if (!/^[!#$%&'*+.^_`|~\w-]+[ \t]*=/.test(part)) {
      if (scheme === "bearer" && /^resource_metadata(?:[ \t=]|$)/i.test(part))
        return { status: "invalid" };
      const challenge = /^([!#$%&'*+.^_`|~\w-]+)(?:[ \t]+(.*))?$/.exec(part);
      scheme = challenge?.[1]?.toLowerCase();
      parameter = challenge?.[2] ?? "";
    }
    if (scheme !== "bearer" || !/^resource_metadata(?:[ \t=]|$)/i.test(parameter)) continue;
    const hint = /^resource_metadata[ \t]*=[ \t]*(?:"((?:\\.|[^"\\])*)"|([^\s,"]+))[ \t]*$/i.exec(
      parameter,
    );
    const value = hint?.[1]?.replace(/\\(.)/g, "$1") ?? hint?.[2];
    if (!value || url !== undefined) return { status: "invalid" };
    url = value;
  }
  return { status: "parsed", url };
};

/** The SDK retries other metadata candidates after broad HTTP failures; allow only absence. */
export const missingOnlyMetadataFetch =
  (fetch: FetchLike): FetchLike =>
  (url, init) =>
    fetch(url, init).then((response) => {
      if (!response.ok && response.status !== 404 && response.status !== 410)
        throw boundaryError("unavailable", "not-sent", "OAuth metadata request failed.");
      return response;
    });

/** Only explicit absence permits synthesized bindings; SDK exception text is never inspected. */
export const discoverAuthResource = (
  endpoint: string,
  resource: URL,
  config: McpOAuthConfig,
  policy: AuthUrlPolicy,
) =>
  withAuthFetch(policy, (fetch, probe) =>
    probe(endpoint).then((challenge) => {
      const metadataFetch = missingOnlyMetadataFetch(fetch);
      const hint = resourceMetadataHint(challenge.headers.get("www-authenticate") ?? "");
      if (hint.status === "invalid") return hint;
      const rawUrl = hint.url;
      let responses = 0;
      let allMissing = true;
      let rejected = false;
      // Only metadata responses establish absence. Probe 401/404/405 statuses do not.
      // An explicit SDK URL disables guessed-path fallback. Keep the raw URL for policy
      // validation because URL construction can erase forbidden whitespace or backslashes.
      return discoverOAuthProtectedResourceMetadata(
        endpoint,
        rawUrl === undefined ? undefined : { resourceMetadataUrl: rawUrl },
        (url, init) =>
          metadataFetch(rawUrl ?? url, init).then(
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
        () =>
          ({ status: responses > 0 && allMissing && !rejected ? "missing" : "invalid" }) as const,
      );
    }),
  ).pipe(
    // withAuthFetch's sticky policy/network failure wins before compatibility is considered.
    Effect.flatMap(
      (result): Effect.Effect<ResourceDiscovery, McpBoundaryError> =>
        Effect.gen(function* () {
          if (result.status === "found") return { metadata: result.metadata };
          if (result.status === "missing") {
            const fallback = yield* resourceMetadataFallback(endpoint, config);
            if (fallback)
              return {
                metadata: { resource: resource.href, authorization_servers: [fallback.issuer] },
                source: fallback.source,
              };
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
        }),
    ),
  );
