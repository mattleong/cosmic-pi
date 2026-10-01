import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Headers from "effect/http/Headers";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcMessage from "effect/rpc/RpcMessage";
import { makeSupervisorChannelSession } from "../src/boundary/supervisor-channel-session.ts";
import { SupervisorRpcConnection } from "../src/boundary/supervisor-rpc-protocol.ts";
import {
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorAuthTokenSchema,
  SupervisorRpcGroup,
  SupervisorRunIdSchema,
  type SupervisorEvent,
} from "../src/supervisor/protocol.ts";

describe("supervisor authentication publication", () => {
  for (const revocation of ["shutdown", "disconnect"] as const) {
    it.effect(`rejects verification that settles after ${revocation}`, () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<boolean>();
        const token = SupervisorAuthTokenSchema.make("4a".repeat(32));
        const runId = SupervisorRunIdSchema.make("agent-authentication-test");
        const events = yield* Queue.bounded<SupervisorEvent, Cause.Done>(16);
        const session = yield* makeSupervisorChannelSession({
          verifyToken: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(completed))),
          runId,
          events,
        });
        const handlers = yield* session.handlers;
        const open = yield* SupervisorRpcGroup.accessHandler("SupervisorOpenSession").pipe(
          Effect.provide(handlers),
        );
        const authenticated = yield* Deferred.make<void>();
        const guard = {
          clientId: 1,
          authenticated,
          accepted: false,
          closed: false,
          close: () => {
            guard.closed = true;
          },
        };
        const pending = yield* open(
          { token, runId, version: SUPERVISOR_CHANNEL_VERSION },
          {
            client: new Rpc.ServerClient(1),
            requestId: RpcMessage.RequestId(1),
            headers: Headers.empty,
          },
        ).pipe(
          Effect.provideService(SupervisorRpcConnection, guard),
          Effect.flip,
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        if (revocation === "shutdown") yield* session.shutdown;
        else guard.close();
        yield* Deferred.succeed(completed, true);
        expect(yield* Fiber.join(pending)).toMatchObject({ code: "authentication_failed" });
        expect(guard.accepted).toBe(false);
        expect(Deferred.isDoneUnsafe(authenticated)).toBe(false);
      }),
    );
  }
});
