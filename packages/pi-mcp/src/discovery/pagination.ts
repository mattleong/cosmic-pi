import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpOperation } from "../connection/model.ts";
import { MCP_DISCOVERY_LIMITS } from "./model.ts";

export type McpListAction =
  | "tools.list"
  | "resources.list"
  | "resources.templates"
  | "prompts.list";
interface MetadataBudget {
  bytes: number;
  nodes: number;
}
export const metadataBudget = (): MetadataBudget => ({ bytes: 0, nodes: 0 });
const tooLarge = () =>
  boundaryError("output-limit", "not-sent", "MCP metadata exceeds discovery limits.");

const isContainer = (
  value: Schema.Json | undefined,
): value is Schema.JsonArray | Schema.JsonObject =>
  Array.isArray(value) || Predicate.isObject(value);

/** Charge serialized UTF-8, including JSON escapes, before decoding or freezing entries. */
export const chargeMetadata = (value: Schema.Json, budget: MetadataBudget): void => {
  const pending: Array<{ value: Schema.Json; depth: number }> = [{ value, depth: 0 }];
  const charge = (text: string): void => {
    if (text.length > MCP_DISCOVERY_LIMITS.metadataBytes) throw tooLarge();
    budget.bytes += new TextEncoder().encode(text).byteLength;
    if (budget.bytes > MCP_DISCOVERY_LIMITS.metadataBytes) throw tooLarge();
  };
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if (
      ++budget.nodes > MCP_DISCOVERY_LIMITS.metadataNodes ||
      item.depth > MCP_DISCOVERY_LIMITS.metadataDepth
    )
      throw tooLarge();
    const current = item.value;
    if (Predicate.isString(current)) {
      if (current.length > MCP_DISCOVERY_LIMITS.metadataBytes) throw tooLarge();
      charge(JSON.stringify(current));
    } else if (!isContainer(current)) {
      charge(String(current));
    } else {
      const entries = Object.entries(current);
      if (entries.length > MCP_DISCOVERY_LIMITS.metadataNodes - budget.nodes) throw tooLarge();
      charge("[]");
      for (const [key, child] of entries) {
        if (!Array.isArray(current)) charge(`${JSON.stringify(key)}:`);
        if (pending.length >= MCP_DISCOVERY_LIMITS.metadataNodes) throw tooLarge();
        pending.push({ value: child, depth: item.depth + 1 });
      }
      budget.bytes += Math.max(0, entries.length - 1);
      if (budget.bytes > MCP_DISCOVERY_LIMITS.metadataBytes) throw tooLarge();
    }
  }
};

/** Input has passed the bounded JSON walk and schema decode. No remote object is retained. */
export const freezeMetadata = <A extends Schema.Json>(value: A): A => {
  const pending: Array<Schema.Json> = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isContainer(current) || Object.isFrozen(current)) continue;
    for (const child of Object.values(current)) pending.push(child);
    Object.freeze(current);
  }
  return value;
};

export type McpMetadataList<A> =
  | { readonly supported: true; readonly entries: ReadonlyArray<A> }
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
  budget: MetadataBudget,
): Effect.Effect<McpMetadataList<A>, McpBoundaryError> =>
  Effect.gen(function* () {
    const result: Array<A> = [];
    const seenCursors = new Set<string>();
    const seenEntries = new Set<string>();
    let cursor: string | undefined;
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
      // Later-page failures are inconsistent traversals, not evidence of an absent method.
      if (reply === undefined)
        return { supported: false, entries: [], reason: "rpc-method-not-found" };
      if (reply.action !== action)
        return yield* Effect.fail(
          boundaryError("protocol", "not-sent", "MCP metadata action mismatch."),
        );
      yield* Effect.try({
        try: () => chargeMetadata(reply.result, budget),
        catch: () => tooLarge(),
      });
      const body = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(reply.result).pipe(
        Effect.mapError(() =>
          boundaryError("protocol", "not-sent", "MCP metadata page is invalid."),
        ),
      );
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
      if (page.nextCursor === undefined) return { supported: true, entries: result };
      if (seenCursors.has(page.nextCursor))
        return yield* Effect.fail(
          boundaryError("protocol", "not-sent", "MCP metadata cursor repeated."),
        );
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

export interface McpDiscoveryPage {
  readonly data: Schema.Json;
  readonly state: McpCursorState;
}

export const discoveryPage = (
  entries: ReadonlyArray<Schema.Json>,
  request: { readonly cursor?: string; readonly limit?: number },
  signature: string,
  namespace: string,
  state: McpCursorState,
): McpDiscoveryPage => {
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
