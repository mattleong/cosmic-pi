import * as Predicate from "effect/Predicate";
import { stripTerminalControls } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import type { McpEffectiveServer, McpResolvedConfig } from "../config/model.ts";
import { discoveryPage, type McpCursorState } from "./pagination.ts";
import type {
  McpCachedDetail,
  McpCachedFamily,
  McpCachedPage,
  McpCachedRef,
  McpCachedRequest,
  McpMetadataSnapshot,
  McpCatalogState,
} from "./model.ts";
import { isToolAllowed } from "./policy.ts";
import { metadataIsFresh } from "./freshness.ts";
import {
  compareDiscoveryCandidates,
  compareDiscoveryText,
  discoverySearchRank,
  prepareDiscoverySearch,
} from "./search.ts";

export interface McpCacheEvidence {
  readonly owner: string;
  readonly state: "refreshing" | "refresh-failed" | "invalidated";
}
export const cachedEntries = (
  snapshot: McpMetadataSnapshot,
  family: McpCachedFamily,
  server: McpEffectiveServer,
) =>
  family === "tools"
    ? snapshot.tools.filter((entry) => isToolAllowed(server, entry.name))
    : snapshot[family];
export const cachedId = (
  family: McpCachedFamily,
  entry: ReturnType<typeof cachedEntries>[number],
): string =>
  family === "resources" && Predicate.isString(entry.uri)
    ? entry.uri
    : family === "templates" && Predicate.isString(entry.uriTemplate)
      ? entry.uriTemplate
      : entry.name;
const safe = (value: string, limit: number) => stripTerminalControls(value).slice(0, limit);
export const cacheVisible = (snapshot: McpMetadataSnapshot, config: McpResolvedConfig) => {
  const server = config.servers[snapshot.server];
  return (
    config.trusted &&
    config.settings.enabled &&
    server?.enabled === true &&
    snapshot.identity === server.identity &&
    snapshot.configRevision === config.revision
  );
};

interface McpCachedQueryResult {
  readonly page: McpCachedPage;
  readonly cursors: McpCursorState;
}

/** Search the whole permitted scope before pagination. No remote identifiers are rewritten. */
export const queryCached = (
  request: McpCachedRequest,
  config: McpResolvedConfig,
  snapshots: ReadonlyMap<string, McpMetadataSnapshot>,
  evidence: ReadonlyMap<string, McpCacheEvidence>,
  cursors: McpCursorState,
  namespace: string,
  now = 0,
): McpCachedQueryResult => {
  const limit = request.limit ?? 40;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (request.query?.length ?? 0) > 512
  )
    throw boundaryError("invalid-input", "not-sent", "MCP cached query is outside its limits.");
  const search = prepareDiscoverySearch(request.query ?? "");
  const servers = Object.values(config.servers)
    .filter(
      (server) =>
        config.trusted &&
        config.settings.enabled &&
        server.enabled &&
        server.definition &&
        (request.server === undefined || request.server === server.id),
    )
    .sort((a, b) => compareDiscoveryText(a.id, b.id));
  const entries: Array<{
    server: string;
    snapshot: McpMetadataSnapshot;
    metadata: ReturnType<typeof cachedEntries>[number];
    id: string;
    rank: number;
  }> = [];
  const signature = [
    "cached",
    request.family,
    request.server ?? "",
    search.text,
    search.words.join(" "),
    String(config.revision),
    String(config.trusted),
  ];
  const catalogs = servers.map((server) => {
    const candidate = snapshots.get(server.id);
    const snapshot = candidate && cacheVisible(candidate, config) ? candidate : undefined;
    const observed = evidence.get(server.id);
    signature.push(
      server.id,
      snapshot?.owner ?? "",
      String(snapshot?.revision ?? 0),
      observed?.state ?? "",
    );
    const catalog = snapshot ? cachedEntries(snapshot, request.family, server) : [];
    for (const metadata of request.catalogsOnly ? [] : catalog) {
      const id = cachedId(request.family, metadata);
      const rank = discoverySearchRank(search, metadata, id);
      if (rank !== undefined && snapshot !== undefined)
        entries.push({ server: server.id, snapshot, metadata, id, rank });
    }
    const state: McpCatalogState =
      observed?.state ??
      (snapshot === undefined
        ? "undiscovered"
        : !snapshot.support[request.family]
          ? "unsupported"
          : !metadataIsFresh(snapshot, now)
            ? "stale"
            : catalog.length === 0
              ? "empty"
              : "ready");
    const catalogState = {
      server: server.id,
      state,
      count: catalog.length,
      revision: snapshot?.revision,
      fresh: snapshot !== undefined && metadataIsFresh(snapshot, now) && observed === undefined,
    };
    const diagnostic = snapshot?.diagnostics.find((item) => item.family === request.family);
    return diagnostic ? { ...catalogState, reason: diagnostic.reason } : catalogState;
  });
  if (request.catalogsOnly)
    return {
      page: { family: request.family, entries: [], catalogs, total: 0, next: undefined },
      cursors,
    };
  const binding = signature.map((part) => `${part.length}:${part}`).join("");
  if (search.text || request.family === "tools") entries.sort(compareDiscoveryCandidates);
  const selected = discoveryPage(
    entries,
    { ...request, limit },
    binding,
    `${namespace}.cached`,
    cursors,
  );
  return {
    page: {
      family: request.family,
      entries: selected.data.items.map(({ server, snapshot, metadata, id }) => ({
        ref: {
          server,
          family: request.family,
          id,
          owner: snapshot.owner,
          revision: snapshot.revision,
          configRevision: snapshot.configRevision,
        },
        name: safe(metadata.name, 1024),
        description: safe(metadata.description ?? "", 512),
      })),
      catalogs,
      total: selected.data.total,
      next: selected.data.nextCursor,
    },
    cursors: selected.state,
  };
};

export const describeCached = (
  ref: McpCachedRef,
  config: McpResolvedConfig,
  snapshots: ReadonlyMap<string, McpMetadataSnapshot>,
): McpCachedDetail => {
  const snapshot = snapshots.get(ref.server);
  if (
    !snapshot ||
    !cacheVisible(snapshot, config) ||
    snapshot.owner !== ref.owner ||
    snapshot.revision !== ref.revision ||
    snapshot.configRevision !== ref.configRevision
  )
    throw boundaryError("stale", "not-sent", "MCP cached detail was withdrawn.");
  const entry = cachedEntries(snapshot, ref.family, config.servers[ref.server]!).find(
    (value) => cachedId(ref.family, value) === ref.id,
  );
  if (!entry) throw boundaryError("not-found", "not-sent", "MCP cached entry is unavailable.");
  // Only metadata fields needed for inspection. Never render icons or follow references/links.
  const fields =
    ref.family === "tools"
      ? {
          inputSchema: entry.inputSchema,
          outputSchema: entry.outputSchema,
          annotations: entry.annotations,
        }
      : ref.family === "prompts"
        ? { arguments: entry.arguments }
        : { mimeType: entry.mimeType, annotations: entry.annotations };
  const metadata = JSON.stringify(fields, null, 2);
  return {
    ref,
    name: safe(entry.name, 1024),
    description: safe(entry.description ?? "", 4096),
    metadata: safe(metadata, 16_384),
    truncated: metadata.length > 16_384 || (entry.description?.length ?? 0) > 4096,
  };
};
