import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { hasControlCharacter, NetworkAddresses } from "pi-cosmic-core";
import { McpCredentialStore } from "../boundary/credential-store.ts";
import type { KeychainOptions } from "../boundary/keychain.ts";
import { McpSdkAuth } from "../boundary/sdk-auth.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import type { McpAuthContract, McpAuthStatus } from "./model.ts";
import { authFailure, oauthConfig } from "./policy.ts";

interface Authority {
  readonly permit: Semaphore.Semaphore;
  generation: number;
  blocked: boolean;
  revoked: Deferred.Deferred<void>;
}
// Grants can be refreshed by replacement runtimes. Native persistence and refresh share
// this process-wide admission, while each runtime separately revokes its own authority.
const authorities = new Map<string, Authority>();
const authorityFor = (identity: string): Authority => {
  let value = authorities.get(identity);
  if (!value) {
    value = {
      permit: Semaphore.makeUnsafe(1),
      generation: 0,
      blocked: false,
      revoked: Deferred.makeUnsafe<void>(),
    };
    authorities.set(identity, value);
  }
  return value;
};
const stale = () => boundaryError("stale", "not-sent", "OAuth operation was revoked.");
const envToken = (name: string) =>
  Config.nonEmptyString(name).pipe(
    Effect.mapError(authFailure),
    Effect.filterOrFail(
      (token) => token.length <= 32768 && !hasControlCharacter(token) && !/\s/.test(token),
      authFailure,
    ),
  );

export const makeMcpAuth = Effect.gen(function* () {
  const store = yield* McpCredentialStore;
  const sdk = yield* McpSdkAuth;
  let disposed = false;
  let sessionGeneration = 0;
  let revoked = Deferred.makeUnsafe<void>();
  const observed = new Map<string, McpAuthStatus>();
  const revoke = Effect.sync(() => {
    sessionGeneration++;
    const previous = revoked;
    revoked = Deferred.makeUnsafe<void>();
    observed.clear();
    Deferred.doneUnsafe(previous, Effect.void);
  });
  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      revoke,
      Effect.sync(() => {
        disposed = true;
      }),
    ),
  );
  const checkServer = (server: McpEffectiveServer) =>
    !disposed && server.enabled && server.definition ? Effect.void : Effect.fail(stale());
  const owned = <A>(server: McpEffectiveServer, work: Effect.Effect<A, McpBoundaryError>) =>
    Effect.suspend(() => {
      const signal = revoked;
      const generation = sessionGeneration;
      const serverSignal = authorityFor(server.identity).revoked;
      const cancelled = Effect.raceFirst(Deferred.await(signal), Deferred.await(serverSignal));
      return Effect.raceFirst(work, cancelled.pipe(Effect.andThen(Effect.fail(stale())))).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (generation === sessionGeneration && !disposed)
              observed.set(server.identity, { state: "ready" });
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (generation === sessionGeneration && !disposed)
              observed.set(server.identity, {
                state: error.kind === "auth-required" ? "required" : "unavailable",
              });
          }),
        ),
      );
    });
  const access: McpAuthContract["access"] = (server) =>
    owned(
      server,
      Effect.gen(function* () {
        yield* checkServer(server);
        const definition = server.definition!;
        if (definition.transport === "stdio" || definition.auth.type === "none") return undefined;
        if (definition.auth.type === "env") return yield* envToken(definition.auth.env);
        const authority = authorityFor(server.identity);
        const generation = authority.generation;
        const session = sessionGeneration;
        const current = () =>
          !disposed &&
          sessionGeneration === session &&
          authority.generation === generation &&
          !authority.blocked;
        return yield* Effect.gen(function* () {
          if (!current()) return yield* authFailure();
          let grant = yield* store.read(server.identity);
          if (!current()) return yield* stale();
          if (!grant) return yield* authFailure();
          const now = yield* Clock.currentTimeMillis;
          if (grant.expiresAt !== undefined && grant.expiresAt <= now + 30_000) {
            const refreshed = yield* sdk.refresh(server, grant);
            if (!current()) return yield* stale();
            yield* store.write(server.identity, refreshed).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (!current()) authority.blocked = true;
                }),
              ),
            );
            if (!current()) return yield* stale();
            grant = refreshed;
          }
          const token = yield* sdk.token(server, grant);
          if (!current()) return yield* stale();
          return token;
        }).pipe(authority.permit.withPermits(1));
      }),
    );
  const login: McpAuthContract["login"] = (server, ui) =>
    owned(
      server,
      Effect.gen(function* () {
        yield* checkServer(server);
        if (!oauthConfig(server)) return yield* authFailure();
        const authority = authorityFor(server.identity);
        const generation = authority.generation;
        const session = sessionGeneration;
        const current = () =>
          !disposed && sessionGeneration === session && authority.generation === generation;
        return yield* Effect.gen(function* () {
          if (!current()) return yield* stale();
          // Probe secure storage before starting a browser or sending registration traffic.
          yield* store.read(server.identity);
          if (!current()) return yield* stale();
          const grant = yield* sdk.login(server, ui);
          if (!current()) return yield* stale();
          yield* store.write(server.identity, grant).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (!current()) authority.blocked = true;
              }),
            ),
          );
          if (!current()) return yield* stale();
          authority.blocked = false;
          return { state: "ready" } as const;
        }).pipe(authority.permit.withPermits(1));
      }),
    );
  const logout: McpAuthContract["logout"] = (server) =>
    Effect.suspend(() => {
      if (!oauthConfig(server))
        return Effect.fail(
          boundaryError("unsupported", "not-sent", "Only stored OAuth grants support logout."),
        );
      observed.set(server.identity, { state: "required" });
      const authority = authorityFor(server.identity);
      authority.generation++;
      authority.blocked = true;
      const previous = authority.revoked;
      authority.revoked = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(previous, Effect.void);
      // Revoke first, then join the permit and the store's native mutation fence.
      return store.remove(server.identity).pipe(authority.permit.withPermits(1));
    });
  const status: McpAuthContract["status"] = (server) =>
    Effect.sync(() => {
      if (disposed || !server.enabled || !server.definition) return { state: "unavailable" };
      if (server.definition.transport === "stdio" || server.definition.auth.type === "none")
        return { state: "none" };
      if (authorities.get(server.identity)?.blocked) return { state: "required" };
      return observed.get(server.identity) ?? { state: "required" };
    });
  return { access, login, logout, status, revoke } satisfies McpAuthContract;
});
export class McpAuth extends Context.Service<McpAuth, McpAuthContract>()(
  "pi-mcp/auth/service/McpAuth",
) {
  static readonly layerWithDependencies = Layer.effect(this, makeMcpAuth);
  static readonly layer = (options: KeychainOptions = {}) =>
    this.layerWithDependencies.pipe(
      Layer.provide(
        Layer.merge(
          McpCredentialStore.layer(options),
          McpSdkAuth.layer.pipe(
            Layer.provide(Layer.merge(NetworkAddresses.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    );
}
