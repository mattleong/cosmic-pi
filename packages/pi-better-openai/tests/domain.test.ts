import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { JsonDocumentError, JsonDocumentStore, provideBuiltLayer } from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import {
  extractAccountIdFromJwt,
  getCodexCredentials,
  getCodexCredentialsResult,
  parseCodexRegistryCredentials,
  readCodexAuthResult,
} from "../src/auth/codex-auth.ts";
import { readConfig, resolveConfig } from "../src/config/index.ts";

const documents = makeInMemoryDocuments;
const context = (token?: string, oauth = true): ExtensionContext => {
  const fixture = {
    cwd: "/project",
    hasUI: true as const,
    model: { provider: "openai", id: "gpt-5.5" },
    modelRegistry: {
      getApiKeyForProvider: () => globalThis.Promise.resolve(token),
      isUsingOAuth: () => oauth,
    },
    ui: { notify() {} },
  };
  // SAFETY: Domain tests exercise only the context fields implemented by this fixture.
  return fixture as typeof fixture & ExtensionContext;
};
// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged results, redacted credentials) for secret fragments.
const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

const jwt = (accountId: string) => {
  const body = Buffer.from(
    `{"https://api.openai.com/auth":{"chatgpt_account_id":"${accountId}"}}`,
  ).toString("base64url");
  return `header.${body}.signature`;
};

describe("OpenAI configuration and credentials", () => {
  it.effect("decodes fields independently and merges project over global", () => {
    const store = documents({
      "/agent/extensions/pi-better-openai.json": {
        usage: { enabled: false, refreshIntervalMs: 30_000, showResetTimes: false },
        image: { defaultSave: "global", timeoutMs: 40_000 },
      },
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true, refreshIntervalMs: "bad" },
        footer: { mode: "status" },
        image: { outputFormat: "webp", defaultSave: "invalid" },
      },
    });
    return Effect.gen(function* () {
      const cfg = yield* resolveConfig("/project", "/agent", true);
      expect(cfg.usage).toMatchObject({
        enabled: true,
        refreshIntervalMs: 30_000,
        showResetTimes: false,
      });
      expect(cfg.footer.mode).toBe("status");
      expect(cfg.image).toMatchObject({
        defaultSave: "global",
        outputFormat: "webp",
        timeoutMs: 40_000,
      });
      const parsed = yield* readConfig("/project/.pi/extensions/pi-better-openai.json");
      expect(parsed?.usage?.enabled).toBe(true);
      expect(parsed?.usage?.refreshIntervalMs).toBeUndefined();
    }).pipe(provideBuiltLayer(Layer.merge(store.layer, Path.layer)));
  });

  it.effect("distinguishes total credential failure from genuine absence", () => {
    const failure = new JsonDocumentError({
      operation: "read",
      path: "/redacted",
      message: "unavailable",
    });
    const layer = Layer.succeed(
      JsonDocumentStore,
      JsonDocumentStore.of({
        exists: () => Effect.fail(failure),
        readObject: () => Effect.fail(failure),
        writeObject: () => Effect.fail(failure),
        modifyObject: () => Effect.fail(failure),
        updateObject: () => Effect.fail(failure),
      }),
    );
    const ctx = context();
    ctx.modelRegistry.getApiKeyForProvider = () => Promise.reject(new Error("registry"));
    return Effect.gen(function* () {
      const result = yield* getCodexCredentialsResult("/auth.json", ctx);
      expect(result._tag).toBe("Unavailable");
      expect(serializedSnapshot(result)).not.toContain("redacted");
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("interrupts a pending model-registry credential lookup", () => {
    const pending = Effect.runPromise(Deferred.await(Deferred.makeUnsafe<string | undefined>()));
    const store = documents();
    const ctx = context();
    ctx.modelRegistry.getApiKeyForProvider = () => pending;
    return Effect.gen(function* () {
      const fiber = yield* getCodexCredentials("/auth.json", ctx).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(true).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(store.layer));
  });

  it.effect("extracts JWT and registry credentials with auth-file fallback and expiry", () => {
    const authPath = "/agent/auth.json";
    const store = documents({
      [authPath]: {
        "openai-codex": {
          type: "oauth",
          access: "file-token",
          accountId: "acct_file",
          expires: 1_000,
        },
      },
    });
    const privateRegistryPayload = JSON.stringify({
      access: "private-registry-token",
      accountId: "acct_registry",
    });
    const registryPayload = JSON.stringify({ access: "registry", accountId: "acct_registry" });
    return Effect.gen(function* () {
      expect(yield* extractAccountIdFromJwt(jwt("acct_jwt"))).toBe("acct_jwt");
      const registry = yield* parseCodexRegistryCredentials(privateRegistryPayload);
      expect(registry?.accountId).toBe("acct_registry");
      if (registry) {
        expect(Redacted.value(registry.accessToken)).toBe("private-registry-token");
        expect(serializedSnapshot(registry)).not.toContain("private-registry-token");
      }
      const file = yield* readCodexAuthResult(authPath);
      expect(file._tag).toBe("Found");
      if (file._tag === "Found") {
        expect(file.credentials.accountId).toBe("acct_file");
        expect(file.credentials.source).toBe("authFile");
        expect(Redacted.value(file.credentials.accessToken)).toBe("file-token");
        expect(serializedSnapshot(file.credentials)).not.toContain("file-token");
      }
      expect((yield* getCodexCredentials(authPath, context()))?.source).toBe("authFile");
      expect((yield* getCodexCredentials(authPath, context(registryPayload)))?.source).toBe(
        "modelRegistry",
      );
      yield* TestClock.adjust("2 seconds");
      expect(yield* readCodexAuthResult(authPath)).toEqual({ _tag: "Missing" });
    }).pipe(provideBuiltLayer(store.layer));
  });
});
