import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import { McpExecution } from "../../src/tools/service.ts";
import { makeObservations } from "../../src/observations/service.ts";
import type { McpProgress } from "../../src/observations/model.ts";
import { optionalFixture, projection } from "../fixtures/optional-features.ts";

it.effect("bounds UTF8 log retention and coalesces progress with fresh-leg resets", () =>
  Effect.gen(function* () {
    const journal = yield* makeObservations;
    for (let i = 0; i < 200; i++)
      journal.publish("fixture", { kind: "log", level: "error", message: "😀".repeat(2_000) });
    for (let i = 0; i < 1_000; i++)
      journal.publish("fixture", { kind: "progress", operation: "one", leg: 1, progress: i });
    journal.publish("fixture", { kind: "progress", operation: "one", leg: 1, progress: 0 });
    journal.publish("fixture", { kind: "progress", operation: "one", leg: 2, progress: 0 });
    journal.publish("fixture", { kind: "progress", operation: "invalid", progress: Infinity });
    const result = yield* journal.read("fixture", undefined, 100);
    expect(result.events.length).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(serialize(result)).byteLength).toBeLessThan(132_000);
    expect(result.events.filter((event) => event.kind === "progress")).toEqual([
      expect.objectContaining({ operation: "one", progress: 0 }),
    ]);
    journal.revoke(["fixture"]);
    expect((yield* journal.read("fixture")).events).toEqual([]);
  }),
);

it.live(
  "captures opt-in redacted remote logs and live bounded progress without steering or deadline resets",
  () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestId: string | number | undefined;
    const seen: McpProgress[] = [];
    const progressed = Deferred.makeUnsafe<void>();
    const encode = (value: Schema.Json) =>
      new TextEncoder().encode(`data: ${serialize(value)}\n\n`);
    const fixture = optionalFixture((request) => {
      if (request.method !== "tools/call") return undefined;
      requestId = request.id;
      const meta = Schema.decodeUnknownSync(
        Schema.Struct({ progressToken: Schema.Union([Schema.String, Schema.Number]) }),
      )(request._meta ?? request.params?._meta);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream;
            stream.enqueue(
              encode({
                jsonrpc: "2.0",
                method: "notifications/message",
                params: { level: "debug", data: "below-threshold" },
              }),
            );
            for (let i = 0; i < 200; i++) {
              stream.enqueue(
                encode({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: {
                    progressToken: meta.progressToken!,
                    progress: i,
                    message: "token=private-value",
                  },
                }),
              );
              stream.enqueue(
                encode({
                  jsonrpc: "2.0",
                  method: "notifications/message",
                  params: { level: "error", data: "token=private-value " + "😀".repeat(2) },
                }),
              );
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      const running = yield* Effect.forkScoped(
        execution.execute(
          { action: "tools.call", server: "fixture", tool: "example", logLevel: "error" },
          {
            ...projection,
            onProgress: (value) => {
              seen.push(value);
              Deferred.doneUnsafe(progressed, Effect.void);
              throw new Error("display failure");
            },
          },
        ),
      );
      yield* Deferred.await(progressed);
      yield* Effect.sleep(30);
      const events = yield* execution.execute(
        { action: "events.read", server: "fixture", limit: 100 },
        projection,
      );
      const text = serialize(events);
      expect(text).not.toMatch(/private-value|below-threshold/);
      const cursor = Schema.decodeUnknownSync(
        Schema.Struct({ result: Schema.Struct({ next: Schema.String }) }),
      )(events.reply.data).result.next;
      const next = yield* execution.execute(
        { action: "events.read", server: "fixture", cursor, limit: 100 },
        projection,
      );
      expect(serialize(next)).toContain("progress");
      expect(text).toContain("log");
      expect(seen.length).toBeLessThanOrEqual(64);
      expect(serialize(seen)).not.toContain("private-value");
      controller!.enqueue(
        encode({
          jsonrpc: "2.0",
          id: requestId!,
          result: { resultType: "complete", content: [{ type: "text", text: "done" }] },
        }),
      );
      controller!.close();
      expect((yield* Fiber.join(running)).reply.outcome).toBe("completed");
      yield* execution.execute({ action: "disconnect", server: "fixture" }, projection);
      expect(
        (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
          .data,
      ).toMatchObject({ result: { events: [] } });
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.live(
  "HTTP logs retain exact stream opt-in and threshold across interleaved requests and immediate terminal frames",
  () => {
    const started = [
      Deferred.makeUnsafe<void>(),
      Deferred.makeUnsafe<void>(),
      Deferred.makeUnsafe<void>(),
    ];
    const active: Array<{
      id: string | number;
      stream: ReadableStreamDefaultController<Uint8Array>;
    }> = [];
    const fixture = optionalFixture((request) => {
      if (request.method !== "tools/call") return undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            active.push({ id: request.id!, stream });
            const ready = started[active.length - 1];
            if (ready) Deferred.doneUnsafe(ready, Effect.void);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      // Resolve discovery once so the three application requests are the only live work.
      yield* execution.execute(
        { action: "tools.describe", server: "fixture", tool: "example" },
        projection,
      );
      const request = { action: "tools.call", server: "fixture", tool: "example" };
      const a = yield* Effect.forkScoped(
        execution.execute({ ...request, logLevel: "error" }, projection),
      );
      yield* Deferred.await(started[0]!);
      const b = yield* Effect.forkScoped(
        execution.execute({ ...request, logLevel: "info" }, projection),
      );
      yield* Deferred.await(started[1]!);
      const c = yield* Effect.forkScoped(execution.execute(request, projection));
      yield* Deferred.await(started[2]!);
      const finish = (index: number, level: string, text: string) => {
        const current = active[index]!;
        const log = (message: string, severity = level) => ({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level: severity, data: message },
        });
        current.stream.enqueue(
          new TextEncoder().encode(
            [
              log("below-threshold", "debug"),
              log(text),
              {
                jsonrpc: "2.0",
                id: current.id,
                result: { resultType: "complete", content: [{ type: "text", text: "done" }] },
              },
              log("after-terminal", "emergency"),
            ]
              .map((value) => `data: ${serialize(value)}\n\n`)
              .join(""),
          ),
        );
        current.stream.close();
      };
      finish(1, "info", "second-stream");
      finish(2, "emergency", "unrequested-stream");
      finish(0, "error", "first-stream");
      yield* Fiber.join(a);
      yield* Fiber.join(b);
      yield* Fiber.join(c);
      const events = yield* execution.execute(
        { action: "events.read", server: "fixture" },
        projection,
      );
      const text = serialize(events);
      expect(text).toContain("second-stream");
      expect(text).toContain("first-stream");
      expect(text).not.toMatch(/below-threshold|unrequested-stream|after-terminal/);
    }).pipe(Effect.provide(fixture.layer));
  },
);
