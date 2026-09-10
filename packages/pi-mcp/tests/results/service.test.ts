import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { describe, expect } from "vitest";
import { boundaryError } from "../../src/client/errors.ts";
import {
  type McpPrepareInput,
  type McpResultsContract,
  type McpRetentionOutcome,
} from "../../src/results/model.ts";
import { makeMcpResults } from "../../src/results/service.ts";

const options = { maxOutputBytes: 4_096, images: false };
const allow = () => Effect.void;
const input = (
  result: Schema.Json,
  server = "server",
  owner = "activation:revision",
): McpPrepareInput => ({
  action: "tools.call",
  server,
  owner,
  reply: { outcome: "completed", result },
});
const idOf = (retention: McpRetentionOutcome): string => {
  if (retention.status !== "retained") throw new Error("Expected retained result");
  return retention.resultId;
};
const save = (service: McpResultsContract, value: McpPrepareInput) =>
  Effect.gen(function* () {
    const prepared = yield* service.prepare(value);
    return { prepared, retention: yield* service.retain(prepared) };
  });
const parse = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

// Each construction owns a separate private activation, even with identical config owners.
describe("MCP result retention", () => {
  it.effect("evicts oldest settled entries without changing order on reads", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults({ maxEntries: 2 });
      const first = yield* save(service, input({ content: [{ type: "text", text: "first" }] }));
      const second = yield* save(service, input({ content: [{ type: "text", text: "second" }] }));
      const firstId = idOf(first.retention);
      yield* service.read({ action: "result.read", id: firstId }, options, allow);
      const third = yield* save(service, input({ content: [] }));
      expect(
        yield* service
          .read({ action: "result.read", id: firstId }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale", outcome: "not-sent" });
      expect(yield* service.retain(first.prepared)).toEqual({
        status: "unretained",
        reason: "unavailable",
      });
      yield* service.read({ action: "result.read", id: idOf(second.retention) }, options, allow);
      yield* service.read({ action: "result.read", id: idOf(third.retention) }, options, allow);
      const projection = yield* service.project(first.prepared, first.retention, options);
      expect(projection.reply).toMatchObject({ outcome: "completed", isError: true });
      expect(projection.reply.resultId).toBeUndefined();
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("enforces the fixed 32-entry ceiling even when a caller asks for more", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults({ maxEntries: 100 });
      const entries = yield* Effect.forEach(
        Array.from({ length: 33 }, (_, index) => index),
        (index) => save(service, input({ index })),
      );
      expect(
        yield* service
          .read({ action: "result.read", id: idOf(entries[0]!.retention) }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
      yield* service.read(
        { action: "result.read", id: idOf(entries[1]!.retention) },
        options,
        allow,
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("enforces the fixed 64 MiB ceiling across accepted results", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults({ maxBytes: Number.MAX_SAFE_INTEGER });
      const text = "x".repeat(7_500_000);
      const first = yield* save(service, input({ content: [{ type: "text", text }] }));
      const second = yield* save(service, input({ content: [{ type: "text", text }] }));
      for (let index = 0; index < 7; index++)
        yield* save(service, input({ content: [{ type: "text", text }] }));
      expect(
        yield* service
          .read({ action: "result.read", id: idOf(first.retention) }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
      yield* service.read({ action: "result.read", id: idOf(second.retention) }, options, allow);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("charges private image bytes in the retention quota", () =>
    Effect.gen(function* () {
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==";
      const service = yield* makeMcpResults({ maxBytes: 900 });
      const first = yield* save(
        service,
        input({ content: [{ type: "image", mimeType: "image/png", data: image }] }),
      );
      expect(first.prepared.images).toHaveLength(1);
      expect(first.prepared.bytes).toBeGreaterThan(image.length + first.prepared.serialized.length);
      yield* save(
        service,
        input({ content: [{ type: "image", mimeType: "image/png", data: image }] }),
      );
      expect(
        yield* service
          .read({ action: "result.read", id: idOf(first.retention) }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("preserves completion and original tool errors when retention is unavailable", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults({ maxEntries: 0 });
      for (const isError of [false, true]) {
        const saved = yield* save(
          service,
          input({ isError, content: [{ type: "text", text: "done" }] }),
        );
        const execution = yield* service.project(saved.prepared, saved.retention, options);
        expect(saved.retention).toEqual({ status: "unretained", reason: "capacity" });
        expect(execution.reply).toMatchObject({
          outcome: "completed",
          isError: true,
          data: { origin: { isError, outcome: "completed" } },
        });
        expect(execution.reply.resultId).toBeUndefined();
        expect(execution.reply.notices.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("does not clear other servers when one server is revoked", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults();
      const first = yield* save(service, input({ secret: "first" }, "one"));
      const second = yield* save(service, input({ secret: "second" }, "two"));
      const pending = yield* service.prepare(input({ secret: "not published" }, "one"));
      yield* service.revoke("one");
      expect(yield* service.retain(pending)).toEqual({ status: "unretained", reason: "revoked" });
      expect(
        yield* service
          .read({ action: "result.read", id: idOf(first.retention) }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
      yield* service.read({ action: "result.read", id: idOf(second.retention) }, options, allow);
      yield* service.revoke();
      expect(
        yield* service
          .read({ action: "result.read", id: idOf(second.retention) }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("does not accept another service activation's results or IDs", () =>
    Effect.gen(function* () {
      const first = yield* makeMcpResults();
      const replacement = yield* makeMcpResults();
      const saved = yield* save(first, input({ private: true }));
      expect(yield* replacement.retain(saved.prepared)).toEqual({
        status: "unretained",
        reason: "revoked",
      });
      expect(
        yield* replacement
          .read({ action: "result.read", id: idOf(saved.retention) }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "rechecks the owner after projection and never returns data after authorization changes",
    () =>
      Effect.gen(function* () {
        const service = yield* makeMcpResults();
        const saved = yield* save(
          service,
          input({ secret: "private" }, "server", "config:revision1"),
        );
        let checks = 0;
        const error = yield* service
          .read({ action: "result.read", id: idOf(saved.retention) }, options, (owner, server) => {
            expect([owner, server]).toEqual(["config:revision1", "server"]);
            return ++checks === 1
              ? Effect.void
              : Effect.fail(boundaryError("denied", "not-sent", "Owner changed."));
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ kind: "denied", outcome: "not-sent" });
        expect(error.message).not.toContain("private");
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("rechecks revocation after a suspended authorization callback", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults();
      const saved = yield* save(service, input({ secret: "private" }));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* service
        .read({ action: "result.read", id: idOf(saved.retention) }, options, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.revoke("server");
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(fiber)).toMatchObject({ kind: "stale" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps retrieval success distinct from original validation and tool failure", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults();
      const saved = yield* save(service, {
        ...input({ isError: false, structuredContent: { value: "invalid" } }),
        outputValidation: "failed",
      });
      const projected = yield* service.project(saved.prepared, saved.retention, options);
      expect(projected.reply).toMatchObject({
        action: "tools.call",
        outcome: "completed",
        isError: true,
        data: { origin: { isError: false, outputValidation: "failed" } },
      });
      const read = yield* service.read(
        { action: "result.read", id: idOf(saved.retention) },
        options,
        allow,
      );
      expect(read.reply).toMatchObject({
        action: "result.read",
        outcome: "completed",
        isError: false,
        data: {
          origin: {
            action: "tools.call",
            outcome: "completed",
            isError: false,
            outputValidation: "failed",
          },
        },
      });
      const data = yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
        read.reply.data,
      );
      expect(parse(data.text)).toMatchObject({ structuredContent: { value: "invalid" } });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("normalizes each binary envelope once without changing the validated reply", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults();
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==";
      const original = {
        isError: true,
        content: [
          { type: "image", mimeType: "image/png", data: png },
          { type: "resource", resource: { mimeType: "image/png", blob: png } },
        ],
        structuredContent: {
          role: "assistant",
          answer: 42,
          nested: [
            { image: { type: "image", mimeType: "image/png", data: png } },
            { audio: { type: "audio", mimeType: "audio/wav", data: "QVVESU8=" } },
            { blob: { mimeType: "application/octet-stream", blob: "QkxPQg==" } },
            { encoded: { base64: "QkFTRTY0" } },
          ],
        },
      };
      const before = structuredClone(original);
      const saved = yield* save(service, { ...input(original), outputValidation: "passed" });
      expect(original).toEqual(before);
      expect(saved.prepared.origin).toMatchObject({
        outcome: "completed",
        isError: true,
        outputValidation: "passed",
      });
      expect(saved.prepared.attachments).toHaveLength(6);
      expect(saved.prepared.images.map((image) => image.index)).toEqual([0, 1, 2]);
      expect(parse(saved.prepared.serialized)).toMatchObject({
        isError: true,
        content: [
          { type: "attachment", index: 0, kind: "image", supported: true },
          { type: "resource", resource: { type: "attachment", index: 1, supported: true } },
        ],
        structuredContent: {
          role: "assistant",
          answer: 42,
          nested: [
            { image: { type: "attachment", index: 2, kind: "image", supported: true } },
            { audio: { type: "attachment", index: 3, kind: "audio", supported: false } },
            { blob: { type: "attachment", index: 4, kind: "resource", supported: false } },
            { encoded: { type: "attachment", index: 5, kind: "unsupported", supported: false } },
          ],
        },
      });
      for (const payload of [png, "QVVESU8=", "QkxPQg==", "QkFTRTY0"])
        expect(saved.prepared.serialized).not.toContain(payload);
      expect(saved.prepared.notices.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("does not reinterpret plain text or nonbinary structured values", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults();
      const literal = '{"type":"image","data":"opaque literal","base64":"literal"}';
      const original = {
        content: [{ type: "text", text: literal }],
        structuredContent: {
          literal,
          type: "custom",
          data: "ordinary data",
          blob: null,
          base64: false,
          values: [
            { type: "image", data: 42 },
            { type: "audio", data: [1, 2] },
          ],
          messages: [{ role: "assistant", content: literal }],
        },
      };
      const saved = yield* save(service, input(original));
      expect(parse(saved.prepared.serialized)).toEqual(original);
      expect(saved.prepared.attachments).toHaveLength(0);
      expect(saved.prepared.images).toHaveLength(0);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("bounds accepted text and binary payloads before retaining them", () =>
    Effect.gen(function* () {
      const service = yield* makeMcpResults();
      const oversized = "A".repeat(8 * 1024 * 1024);
      for (const result of [
        { content: [{ type: "text", text: "x".repeat(8 * 1024 * 1024) }] },
        { content: [{ type: "audio", mimeType: "audio/wav", data: oversized }] },
        {
          structuredContent: { nested: { type: "image", mimeType: "image/png", data: oversized } },
        },
        { structuredContent: { nested: { blob: oversized } } },
        { structuredContent: { nested: { base64: oversized } } },
      ]) {
        const saved = yield* save(service, input(result));
        expect(saved.retention).toEqual({ status: "unretained", reason: "output-limit" });
        expect(saved.prepared.images).toHaveLength(0);
        expect(saved.prepared.serialized).toBe("null");
        const projected = yield* service.project(saved.prepared, saved.retention, options);
        expect(projected.reply).toMatchObject({ outcome: "completed", isError: true });
        expect(projected.reply.resultId).toBeUndefined();
      }
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("revokes all retained data when its owning scope closes", () =>
    Effect.gen(function* () {
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* makeMcpResults();
          const result = yield* save(service, input({ private: true }));
          return { service, id: idOf(result.retention) };
        }),
      );
      expect(
        yield* saved.service
          .read({ action: "result.read", id: saved.id }, options, allow)
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
      expect(
        yield* saved.service.prepare(input({ private: true })).pipe(Effect.flip),
      ).toMatchObject({ kind: "denied" });
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
