import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { provideBuiltLayer } from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { getCodexCredentials } from "../src/auth/codex-auth.ts";
import { readConfig, resolveConfig } from "../src/config/store.ts";
import { serializedSnapshot, testContext } from "./helpers.ts";

const jwt = (accountId: string) => {
  const body = Buffer.from(
    `{"https://api.openai.com/auth":{"chatgpt_account_id":"${accountId}"}}`,
  ).toString("base64url");
  return `header.${body}.signature`;
};

describe("OpenAI configuration and credentials", () => {
  it.effect("decodes fields independently and merges project over global", () => {
    const store = makeInMemoryDocuments({
      "/agent/extensions/pi-better-openai.json": {
        usage: { refreshIntervalMs: 30_000, showResetTimes: false },
        image: { defaultSave: "global", timeoutMs: 40_000 },
      },
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { showOnlyOnSubscriptionModels: false, refreshIntervalMs: "bad" },
        image: { outputFormat: "webp", defaultSave: "invalid" },
      },
    });
    return Effect.gen(function* () {
      const cfg = yield* resolveConfig("/project", "/agent", true);
      expect(cfg.usage).toMatchObject({
        showOnlyOnSubscriptionModels: false,
        refreshIntervalMs: 30_000,
        showResetTimes: false,
      });
      expect(cfg.image).toMatchObject({
        defaultSave: "global",
        outputFormat: "webp",
        timeoutMs: 40_000,
      });
      const parsed = yield* readConfig("/project/.pi/extensions/pi-better-openai.json");
      expect(parsed?.usage?.showOnlyOnSubscriptionModels).toBe(false);
      expect(parsed?.usage?.refreshIntervalMs).toBeUndefined();
    }).pipe(provideBuiltLayer(Layer.merge(store.layer, Path.layer)));
  });

  it.effect("fails a rejected registry lookup with a fixed, sanitized message", () =>
    Effect.gen(function* () {
      const rejection = new Error("refresh failed for codex-secret-token: error_description");
      const failure = yield* getCodexCredentials(testContext({ token: rejection })).pipe(
        Effect.flip,
      );
      expect(failure).toMatchObject({
        operation: "registry",
        message: "Unable to read openai-codex credentials.",
      });
      expect(serializedSnapshot(failure)).not.toMatch(/codex-secret-token|error_description/);
    }),
  );

  it.effect("treats an absent or empty registry key as missing credentials", () =>
    Effect.gen(function* () {
      for (const token of [undefined, ""])
        expect(yield* getCodexCredentials(testContext({ token }))).toBeUndefined();
    }),
  );

  it.effect("interrupts a pending model-registry credential lookup", () => {
    const pending = Deferred.makeUnsafe<undefined>();
    const ctx = testContext();
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Deferred.succeed(pending, undefined));
      const started = yield* Deferred.make<void>();
      ctx.modelRegistry.getProviderAuth = () => {
        Deferred.doneUnsafe(started, Effect.void);
        return Effect.runPromise(Deferred.await(pending));
      };
      const fiber = yield* getCodexCredentials(ctx).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }).pipe(Effect.scoped);
  });

  it.effect("parses lossy registry keys into redacted credentials", () => {
    const rawJwt = jwt("acct_jwt");
    const payload = JSON.stringify({
      access: "private-registry-token",
      accountId: "acct_registry",
    });
    return Effect.gen(function* () {
      const fromJwt = yield* getCodexCredentials(testContext({ token: ` ${rawJwt}\n` }));
      expect(fromJwt?.accountId).toBe("acct_jwt");
      expect(fromJwt && Redacted.value(fromJwt.accessToken)).toBe(rawJwt);

      const fromPayload = yield* getCodexCredentials(testContext({ token: payload }));
      expect(fromPayload?.accountId).toBe("acct_registry");
      expect(fromPayload && Redacted.value(fromPayload.accessToken)).toBe("private-registry-token");

      for (const malformed of ["{malformed-registry", "malformed-jwt", "   "]) {
        const failure = yield* getCodexCredentials(testContext({ token: malformed })).pipe(
          Effect.flip,
        );
        expect(failure.operation).toBe("registry-decode");
      }
      const serialized = serializedSnapshot([fromJwt, fromPayload]);
      expect(serialized).not.toContain(rawJwt);
      expect(serialized).not.toContain("private-registry-token");
    });
  });
});
