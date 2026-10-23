import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { currentProcessIdentity } from "pi-cosmic-core/platform/process-start";
import { synchronousRandomHex } from "pi-cosmic-core/platform/native-crypto";
import { INSTANCE_BYTES, sessionRecord, TOKEN_BYTES } from "../registry/schema.ts";
import { IntercomRegistry } from "../registry/store.ts";
import { serveIntercom } from "../transport/server.ts";

/** The Pi session a runtime registers, as captured at `session_start`. */
export interface IntercomSessionInput {
  readonly sessionId: string;
  readonly name: string | undefined;
  readonly cwd: string;
}

/**
 * Owns this session runtime's registry record and socket from startup to disposal. Startup
 * reserves the socket path, writes the record with a fresh instance and token, and then listens,
 * so a crash after binding always leaves a record naming the socket for a later sweep. It then
 * sweeps records of dead owners in the background, which startup doesn't wait for. Name changes
 * rewrite the record. Disposal interrupts the sweep, closes the listener and removes its socket,
 * then removes the record after any rewrite in progress, and no rewrite can follow.
 */
export class IntercomSession extends Context.Service<IntercomSession>()(
  "pi-intercom/session/service/IntercomSession",
  {
    make: Effect.fn("IntercomSession.make")(function* (input: IntercomSessionInput) {
      const registry = yield* IntercomRegistry;
      const instance = yield* Effect.sync(() => synchronousRandomHex(INSTANCE_BYTES));
      const token = yield* Effect.sync(() => synchronousRandomHex(TOKEN_BYTES));
      const owner = yield* Effect.sync(currentProcessIdentity);
      const socket = yield* registry.reserveSocket(instance, owner);
      const initial = sessionRecord({
        instance,
        pid: owner.pid,
        started: owner.started,
        sessionId: input.sessionId,
        name: input.name,
        cwd: input.cwd,
        socket,
        token,
      });

      const writes = yield* Semaphore.make(1);
      const current = yield* Ref.make(initial);
      let retired = false;
      yield* Effect.acquireRelease(registry.write(initial), () =>
        writes
          .withPermit(
            Effect.suspend(() => {
              retired = true;
              return registry.remove(instance);
            }),
          )
          .pipe(Effect.catch(() => Effect.logWarning("Couldn't remove the intercom record."))),
      );

      yield* serveIntercom({ socket, token });

      // Nothing here depends on the sweep: this instance is fresh, and listings skip records of
      // dead owners. A peer that never answers would hold startup for the describe deadline.
      const sweep = yield* registry.sweep().pipe(
        Effect.tap(({ records, socketDirectories }) =>
          records + socketDirectories > 0
            ? Effect.logDebug("Swept intercom registrations of dead sessions.").pipe(
                Effect.annotateLogs({ records, socketDirectories }),
              )
            : Effect.void,
        ),
        Effect.catch(() => Effect.logWarning("Couldn't sweep the intercom registry.")),
        Effect.forkScoped,
      );

      const rename = Effect.fn("IntercomSession.rename")(
        function* (name: string | undefined) {
          if (retired) return;
          const previous = yield* Ref.get(current);
          const next = sessionRecord({ ...previous, started: previous.started, name });
          yield* registry.write(next);
          yield* Ref.set(current, next);
        },
        (effect) => writes.withPermit(effect),
      );

      /** This runtime's current record: its own instance and the identity it sends as. */
      const record = Ref.get(current);

      /** Ends once the sweep started with this runtime has finished or been interrupted. */
      const swept = Effect.asVoid(Fiber.await(sweep));

      return { rename, record, swept };
    }),
  },
) {
  static readonly layer = (input: IntercomSessionInput) => Layer.effect(this, this.make(input));
}
