import * as Predicate from "effect/Predicate";
import { stripTerminalControls } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import type { McpEffectiveServer, McpResolvedConfig } from "../config/model.ts";
import type { McpCursorState } from "./pagination.ts";
import type {
  McpCachedDetail,
  McpCachedEntry,
  McpCachedFamily,
  McpCachedPage,
  McpCachedRef,
  McpCachedRequest,
  McpMetadataSnapshot,
  McpCatalogState,
} from "./model.ts";
import { isToolAllowed } from "./policy.ts";

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
): McpCachedQueryResult => {
  const limit = request.limit ?? 40;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (request.query?.length ?? 0) > 512
  )
    throw boundaryError("invalid-input", "not-sent", "MCP cached query is outside its limits.");
  const query = (request.query ?? "").toLocaleLowerCase();
  const servers = Object.values(config.servers)
    .filter(
      (server) =>
        config.trusted &&
        config.settings.enabled &&
        server.enabled &&
        server.definition &&
        (request.server === undefined || request.server === server.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const entries: McpCachedEntry[] = [];
  const prior = request.cursor ? cursors.entries.get(request.cursor) : undefined;
  if (request.cursor && !prior)
    throw boundaryError("stale", "not-sent", "MCP cached cursor is no longer current.");
  const offset = prior?.offset ?? 0;
  let total = 0;
  const signature = [
    request.family,
    request.server ?? "",
    query,
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
    for (const entry of catalog) {
      const id = cachedId(request.family, entry);
      if (
        query &&
        !`${id}\n${entry.name}\n${entry.description ?? ""}`.toLocaleLowerCase().includes(query)
      )
        continue;
      const index = total++;
      if (index < offset || entries.length >= limit) continue;
      entries.push({
        ref: {
          server: server.id,
          family: request.family,
          id,
          owner: snapshot!.owner,
          revision: snapshot!.revision,
          configRevision: snapshot!.configRevision,
        },
        name: safe(entry.name, 1024),
        description: safe(entry.description ?? "", 512),
      });
    }
    const state: McpCatalogState =
      observed?.state ??
      (snapshot === undefined
        ? "undiscovered"
        : !snapshot.support[request.family]
          ? "unsupported"
          : catalog.length === 0
            ? "empty"
            : "ready");
    const catalogState = {
      server: server.id,
      state,
      count: catalog.length,
      revision: snapshot?.revision,
    };
    const diagnostic = snapshot?.diagnostics.find((item) => item.family === request.family);
    return diagnostic ? { ...catalogState, reason: diagnostic.reason } : catalogState;
  });
  const binding = signature.map((part) => `${part.length}:${part}`).join("");
  if (request.cursor && (!prior || prior.signature !== binding))
    throw boundaryError("stale", "not-sent", "MCP cached cursor is no longer current.");
  const shown = entries;
  const end = offset + shown.length;
  let next: string | undefined;
  let updated = cursors;
  if (end < total) {
    next = `${namespace}.cached.${cursors.sequence + 1}`;
    const retained = new Map(cursors.entries);
    retained.set(next, { signature: binding, offset: end });
    while (retained.size > 1024) retained.delete(retained.keys().next().value!);
    updated = { sequence: cursors.sequence + 1, entries: retained };
  }
  return {
    page: { family: request.family, entries: shown, catalogs, total, next },
    cursors: updated,
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
