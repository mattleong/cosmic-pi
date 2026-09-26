import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpOperation } from "../connection/model.ts";
import { measureBoundedJson, type BoundedJsonUsage } from "../validation/schema-policy.ts";
import { MCP_DISCOVERY_LIMITS } from "./model.ts";
import { metadataFreshness, metadataTime, type McpMetadataFreshness } from "./freshness.ts";

export type McpListAction =
  | "tools.list"
  | "resources.list"
  | "resources.templates"
  | "prompts.list";
/** Shared by every page and family of one collection. */
export const metadataBudget = (): Types.Mutable<BoundedJsonUsage> => ({ bytes: 0, nodes: 0 });
const tooLarge = () =>
  boundaryError("output-limit", "not-sent", "MCP metadata exceeds discovery limits.");

export type McpMetadataList<A> =
  | (Required<McpMetadataFreshness> & {
      readonly supported: true;
      readonly entries: ReadonlyArray<A>;
    })
  | {
      readonly supported: false;
      readonly entries: readonly [];
      readonly reason: "rpc-method-not-found";
    };

export const listMetadata = <A extends Schema.Json>(
  operation: McpOperation,
  action: McpListAction,
  field: "tools" | "resources" | "resourceTemplates" | "prompts",
  entry: Schema.Codec<A>,
  key: (item: A) => string,
  budget: Types.Mutable<BoundedJsonUsage>,
): Effect.Effect<McpMetadataList<A>, McpBoundaryError> =>
  Effect.gen(function* () {
    const result: Array<A> = [];
    const seenCursors = new Set<string>();
    const seenEntries = new Set<string>();
    let cursor: string | undefined;
    let expiresAt = Number.POSITIVE_INFINITY;
    let cacheScope: "public" | "private" = "public";
    const Page = Schema.Struct({
      entries: Schema.Array(entry).check(Schema.isMaxLength(MCP_DISCOVERY_LIMITS.entriesPerFamily)),
      nextCursor: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(MCP_DISCOVERY_LIMITS.cursorBytes)),
      ),
    });
    for (let pageNumber = 0; pageNumber < MCP_DISCOVERY_LIMITS.pages; pageNumber++) {
      const reply = yield* operation
        .request(cursor === undefined ? { action } : { action, cursor })
        .pipe(
          Effect.catch((error) =>
            pageNumber === 0 &&
            error.kind === "unsupported" &&
            error.outcome === "completed" &&
            error.reason === "rpc-method-not-found"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
      const receivedAt = yield* metadataTime;
      // Later-page failures are inconsistent traversals, not evidence of an absent method.
      if (reply === undefined)
        return { supported: false, entries: [], reason: "rpc-method-not-found" };
      if (reply.action !== action)
        return yield* boundaryError("protocol", "not-sent", "MCP metadata action mismatch.");
      // Charge serialized UTF-8, including JSON escapes, against the remaining budget before decoding.
      const usage = yield* Effect.try({
        try: () =>
          measureBoundedJson(reply.result, {
            bytes: MCP_DISCOVERY_LIMITS.metadataBytes - budget.bytes,
            depth: MCP_DISCOVERY_LIMITS.metadataDepth,
            nodes: MCP_DISCOVERY_LIMITS.metadataNodes - budget.nodes,
          }),
        catch: () => tooLarge(),
      });
      budget.bytes += usage.bytes;
      budget.nodes += usage.nodes;
      const body = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(reply.result).pipe(
        Effect.mapError(() =>
          boundaryError("protocol", "not-sent", "MCP metadata page is invalid."),
        ),
      );
      const freshness = metadataFreshness(body, receivedAt);
      expiresAt = Math.min(expiresAt, freshness.expiresAt);
      if (freshness.cacheScope === "private") cacheScope = "private";
      const input =
        body.nextCursor === undefined
          ? { entries: body[field] }
          : { entries: body[field], nextCursor: body.nextCursor };
      const page = yield* Schema.decodeUnknownEffect(Page)(input).pipe(
        Effect.mapError(() =>
          boundaryError("protocol", "not-sent", "MCP metadata page is invalid."),
        ),
      );
      const entries = page.entries;
      if (result.length + entries.length > MCP_DISCOVERY_LIMITS.entriesPerFamily)
        return yield* Effect.fail(tooLarge());
      for (const item of entries) {
        const identity = key(item);
        if (seenEntries.has(identity))
          return yield* Effect.fail(
            boundaryError("protocol", "not-sent", "MCP metadata contains duplicate entries."),
          );
        seenEntries.add(identity);
        result.push(item);
      }
      if (page.nextCursor === undefined)
        return { supported: true, entries: result, expiresAt, cacheScope };
      if (seenCursors.has(page.nextCursor))
        return yield* boundaryError("protocol", "not-sent", "MCP metadata cursor repeated.");
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return yield* Effect.fail(tooLarge());
  });

export interface McpCursorBinding {
  /** Includes action, selected servers, config revision, metadata revisions, and search filter. */
  readonly signature: string;
  readonly offset: number;
}
export interface McpCursorState {
  readonly sequence: number;
  readonly entries: ReadonlyMap<string, McpCursorBinding>;
}
export const emptyCursorState = (): McpCursorState => ({ sequence: 0, entries: new Map() });

export interface McpDiscoveryPage<A> {
  readonly data: {
    readonly items: ReadonlyArray<A>;
    readonly total: number;
    readonly nextCursor?: string;
  };
  readonly state: McpCursorState;
}

/** Select references first; callers materialize output only for this local page. */
export const discoveryPage = <A>(
  entries: ReadonlyArray<A>,
  request: { readonly cursor?: string; readonly limit?: number },
  signature: string,
  namespace: string,
  state: McpCursorState,
): McpDiscoveryPage<A> => {
  const limit = request.limit ?? MCP_DISCOVERY_LIMITS.defaultPage;
  if (!Number.isInteger(limit) || limit < 1 || limit > MCP_DISCOVERY_LIMITS.maximumPage)
    throw boundaryError("invalid-input", "not-sent", "MCP discovery page limit is invalid.");
  const previous = request.cursor === undefined ? undefined : state.entries.get(request.cursor);
  if (request.cursor !== undefined && (previous === undefined || previous.signature !== signature))
    throw boundaryError(
      "stale",
      "not-sent",
      "MCP discovery cursor is stale or belongs to another query.",
    );
  const offset = previous?.offset ?? 0;
  const end = Math.min(entries.length, offset + limit);
  const items = entries.slice(offset, end);
  if (end === entries.length) return { data: { items, total: entries.length }, state };
  const next = `${namespace}.${state.sequence + 1}`;
  const cursors = new Map(state.entries);
  cursors.set(next, { signature, offset: end });
  if (cursors.size > MCP_DISCOVERY_LIMITS.retainedCursors) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
  return {
    data: { items, total: entries.length, nextCursor: next },
    state: { sequence: state.sequence + 1, entries: cursors },
  };
};
