import { Buffer } from "node:buffer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vitest";
import type {
  McpPrepareInput,
  McpPreparedResult,
  McpResultsContract,
} from "../../src/results/model.ts";
import { normalizeResult } from "../../src/results/normalize.ts";
import { projectPrepared } from "../../src/results/projection.ts";
import {
  McpGatewayReplySchema,
  type McpGatewayExecution,
  type McpProjectionOptions,
} from "../../src/tools/model.ts";

export const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==";
export const allow = () => Effect.void;
export const opts = (maxOutputBytes: number, images = false) => ({ maxOutputBytes, images });
export const input = (
  result: Schema.Json,
  action = "tools.call",
  owner = "config:revision",
): McpPrepareInput => ({
  action,
  owner,
  server: "server",
  reply: { outcome: "completed", result },
});

/** Normalizes a completed remote result and projects it as a retained gateway reply. */
export const projectReply = (action: string, result: Schema.Json, resultId = "saved") =>
  projectPrepared(
    {
      ...normalizeResult({ ...input(result, action, "owner"), server: "docs" }),
      owner: "owner",
      server: "docs",
      activation: {},
      generation: 0,
    },
    { status: "retained", resultId },
    opts(51_200),
  );

/** Retains a prepared result and narrows the outcome to its retained ID. */
export const retained = (service: McpResultsContract, prepared: McpPreparedResult) =>
  Effect.gen(function* () {
    const retention = yield* service.retain(prepared);
    if (retention.status !== "retained") throw new Error("Expected retention");
    return retention;
  });

export const page = Schema.decodeUnknownSync(
  Schema.Struct({
    text: Schema.String,
    offset: Schema.Natural,
    next: Schema.NullOr(Schema.Natural),
    total: Schema.Natural,
  }),
);
export const encodeExecution = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      reply: McpGatewayReplySchema,
      images: Schema.Array(
        Schema.Struct({
          type: Schema.Literal("image"),
          data: Schema.String,
          mimeType: Schema.String,
        }),
      ),
    }),
  ),
);

/** Reads every retained page, checking each page's byte bound and forward `next` offset. */
export const readAll = (
  service: McpResultsContract,
  id: string,
  options: McpProjectionOptions,
  extras: { readonly limit?: number } = {},
  onPage: (execution: McpGatewayExecution) => void = () => undefined,
) =>
  Effect.gen(function* () {
    let offset: number | null = 0;
    let text = "";
    while (offset !== null) {
      const execution = yield* service.read(
        { action: "result.read", id, offset, ...extras },
        options,
        allow,
      );
      expect(Buffer.byteLength(encodeExecution(execution))).toBeLessThanOrEqual(
        options.maxOutputBytes,
      );
      onPage(execution);
      const slice = page(execution.reply.data);
      expect(slice.next === null || slice.next > offset).toBe(true);
      text += slice.text;
      offset = slice.next;
    }
    return text;
  });
