import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import { nodeCreateHttpServer } from "./node-builtins.ts";

/** Scoped Node listener. Consumers own routing, bind policy, and graceful shutdown options. */
export const nodeHttpServerLayer = (options: NodeHttpServer.Options) =>
  Layer.merge(
    NodeHttpServer.layerHttpServices,
    Layer.effect(
      HttpServer.HttpServer,
      Effect.gen(function* () {
        const native = nodeCreateHttpServer();
        const server = yield* NodeHttpServer.make(() => native, options);
        // Installed after listening, so this runs before NodeHttpServer's close/join finalizer.
        // Active clients cannot keep the scope alive after its graceful shutdown window.
        yield* Effect.addFinalizer(() => Effect.sync(() => native.closeAllConnections()));
        return server;
      }),
    ),
  );
