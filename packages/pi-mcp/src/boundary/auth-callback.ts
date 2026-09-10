import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpMiddleware,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { nodeHttpServerLayer } from "pi-cosmic-core";
import { callbackRedirect, deniedAuth } from "../auth/policy.ts";
import { boundaryError } from "../client/errors.ts";

export const openAuthCallback = (configured?: string) =>
  Effect.gen(function* () {
    const redirect = yield* callbackRedirect(configured);
    const received = yield* Deferred.make<string>();
    const services = yield* Layer.build(
      nodeHttpServerLayer({
        host: "127.0.0.1",
        port: redirect.port ? Number(redirect.port) : 80,
        disablePreemptiveShutdown: true,
      }),
    ).pipe(
      Effect.mapError(() =>
        boundaryError("unavailable", "not-sent", "OAuth callback listener is unavailable."),
      ),
    );
    const server = Context.get(services, HttpServer.HttpServer);
    if (server.address._tag !== "TcpAddress") return yield* deniedAuth();
    redirect.port = String(server.address.port);
    let consumed = false;
    yield* server
      .serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (
            consumed ||
            request.method !== "GET" ||
            request.url.length > 8192 ||
            request.headers.host !== redirect.host ||
            !request.url.startsWith("/") ||
            request.url.startsWith("//")
          )
            return HttpServerResponse.empty({ status: 404 });
          const callback = yield* Effect.try({
            try: () => new URL(request.url, redirect),
            catch: deniedAuth,
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (!callback || callback.pathname !== redirect.pathname)
            return HttpServerResponse.empty({ status: 404 });
          consumed = true;
          yield* Deferred.succeed(received, callback.href);
          return HttpServerResponse.text(
            '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MCP sign-in response</title><main><h1>Sign-in response received</h1><p>Return to Pi to finish.</p></main></html>',
            {
              contentType: "text/html; charset=utf-8",
              headers: {
                "cache-control": "no-store",
                "content-security-policy":
                  "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff",
              },
            },
          );
        }),
      )
      .pipe(
        Effect.provide(services),
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, () => true),
      );
    return {
      redirectUri: redirect.href,
      // The SDK attempt owns the one applicable deadline, beginning before discovery.
      receive: Deferred.await(received),
    };
  });
