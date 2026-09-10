import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpClient, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { expect } from "vitest";
import { nodeHttpServerLayer } from "../src/platform/http-server.ts";

it.live("closes an active HTTP request without a preemptive grace wait when disabled", () =>
  Effect.gen(function* () {
    const owner = yield* Scope.fork(yield* Effect.scope);
    const entered = yield* Deferred.make<void>();
    const context = yield* Layer.build(
      nodeHttpServerLayer({ host: "127.0.0.1", port: 0, disablePreemptiveShutdown: true }),
    ).pipe(Effect.provideService(Scope.Scope, owner));
    const server = Context.get(context, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP listener.");
    yield* server
      .serve(
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.interruptible,
        ),
      )
      .pipe(Effect.provide(context), Effect.provideService(Scope.Scope, owner));
    const client = yield* HttpClient.HttpClient;
    const request = yield* client
      .get(`http://127.0.0.1:${server.address.port}/`)
      .pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Scope.close(owner, Exit.void);
    expect((yield* Fiber.join(request))._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
);

it.live("owns an ephemeral listener and closes it with its scope", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const endpoint = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(nodeHttpServerLayer({ host: "127.0.0.1", port: 0 }));
        const server = Context.get(context, HttpServer.HttpServer);
        if (server.address._tag !== "TcpAddress")
          return yield* Effect.die("Expected TCP listener.");
        yield* server
          .serve(Effect.succeed(HttpServerResponse.text("owned")))
          .pipe(Effect.provide(context));
        const endpoint = `http://127.0.0.1:${server.address.port}/`;
        const response = yield* client.get(endpoint);
        expect(yield* response.text).toBe("owned");
        return endpoint;
      }),
    );
    expect((yield* client.get(endpoint).pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
);
