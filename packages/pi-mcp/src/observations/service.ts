import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent, stripTerminalControls } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import { prefixBytes } from "../results/normalize.ts";
import { MCP_OBSERVATION_LIMITS, type McpObservedEvent, type McpRemoteEvent } from "./model.ts";

export const remoteText = (text: string): string =>
  prefixBytes(
    sanitizeDiagnosticContent(stripTerminalControls(text.slice(0, 16_384)), {
      maximumLength: 16_384,
    }),
    MCP_OBSERVATION_LIMITS.messageBytes,
  );

/** One session-owned observational ring. Native ingress is synchronous and never runs Effects.
 * Every mutation is total and contains no yield; callbacks must supply current-owner authority.
 */
export const makeObservations = Effect.gen(function* () {
  let sequence = 0;
  let bytes = 0;
  const entries: Array<{ server: string; bytes: number; value: McpObservedEvent }> = [];
  const evicted = new Map<string, number>();
  const remove = (index: number) => {
    bytes -= entries[index]!.bytes;
    entries.splice(index, 1);
  };
  const revoke = (servers: ReadonlyArray<string>) => {
    for (const server of servers) evicted.delete(server);
    for (let index = entries.length - 1; index >= 0; index--)
      if (servers.includes(entries[index]!.server)) remove(index);
  };
  const publish = (server: string, event: McpRemoteEvent) => {
    if (event.kind === "progress") {
      if (
        !Number.isFinite(event.progress) ||
        event.progress < 0 ||
        (event.total !== undefined &&
          (!Number.isFinite(event.total) || event.total < event.progress))
      )
        return;
      const prior = entries.findIndex(
        (entry) =>
          entry.server === server &&
          entry.value.event.kind === "progress" &&
          entry.value.event.operation === event.operation,
      );
      if (prior >= 0) {
        const value = entries[prior]!.value.event;
        if (
          value.kind === "progress" &&
          value.leg === event.leg &&
          event.progress <= value.progress
        )
          return;
        remove(prior);
      }
    }
    const safe: McpRemoteEvent =
      event.kind === "log"
        ? { ...event, message: remoteText(event.message) }
        : event.kind === "progress" && event.message !== undefined
          ? { ...event, message: remoteText(event.message) }
          : event;
    const value = { cursor: String(++sequence), event: safe };
    const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (size > MCP_OBSERVATION_LIMITS.bytes) {
      evicted.set(server, sequence);
      return;
    }
    entries.push({ server, bytes: size, value });
    bytes += size;
    while (
      entries.length > MCP_OBSERVATION_LIMITS.entries ||
      bytes > MCP_OBSERVATION_LIMITS.bytes
    ) {
      evicted.set(entries[0]!.server, Number(entries[0]!.value.cursor));
      remove(0);
    }
    return safe;
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      entries.length = 0;
      bytes = 0;
      evicted.clear();
    }),
  );
  return {
    publish,
    revoke,
    read: (server: string, cursor?: string, limit = 32) =>
      Effect.suspend(() => {
        if (
          (cursor !== undefined && !/^(0|[1-9]\d{0,15})$/.test(cursor)) ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100
        )
          return Effect.fail(
            boundaryError("invalid-input", "not-sent", "Invalid MCP event cursor or limit."),
          );
        const after = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(after) || after > sequence)
          return Effect.fail(
            boundaryError("stale", "not-sent", "MCP event cursor is unavailable."),
          );
        const available = entries.filter((entry) => entry.server === server);
        const page = available
          .filter((entry) => Number(entry.value.cursor) > after)
          .slice(0, limit);
        return Effect.succeed({
          server,
          events: page.map(({ value }): Schema.JsonObject => {
            const event = value.event;
            if (event.kind === "resource-updated")
              return { cursor: value.cursor, kind: event.kind, uri: event.uri };
            if (event.kind === "log") return { cursor: value.cursor, ...event };
            let data: Schema.JsonObject = {
              cursor: value.cursor,
              kind: event.kind,
              operation: event.operation,
              progress: event.progress,
            };
            if (event.total !== undefined) data = { ...data, total: event.total };
            if (event.message !== undefined) data = { ...data, message: event.message };
            return data;
          }),
          next: page.at(-1)?.value.cursor ?? String(sequence),
          truncated: after < (evicted.get(server) ?? 0),
        });
      }),
  };
});
