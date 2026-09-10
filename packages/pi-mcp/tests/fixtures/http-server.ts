import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer, HttpServerRequest, type HttpServerResponse } from "effect/unstable/http";

export interface HttpRequestRecord {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export type HttpServerHandler = (
  request: HttpRequestRecord,
) => Effect.Effect<HttpServerResponse.HttpServerResponse>;

/** Real loopback HTTP with Effect-owned listener, request fibers, and stream cleanup. */
export const startHttpServer = (handler: HttpServerHandler) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(NodeHttpServer.layerTest);
    const server = Context.get(services, HttpServer.HttpServer);
    const requests: HttpRequestRecord[] = [];
    yield* server.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const record: HttpRequestRecord = {
          method: request.method,
          headers: request.headers,
          body: yield* request.text,
        };
        requests.push(record);
        return yield* handler(record);
      }).pipe(Effect.interruptible),
    );
    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.die("Owned HTTP fixture did not expose a TCP address.");
    }
    return {
      url: new URL(`http://127.0.0.1:${server.address.port}/mcp`),
      requests,
    };
  });
