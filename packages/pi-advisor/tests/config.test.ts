import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { JsonDocumentStore } from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { describe, expect, test } from "vitest";
import { writeAdvisorConfigPatchEffect } from "../src/config/store.ts";
import {
  DEFAULT_ADVISOR_CONFIG,
  normalizeAdvisorConfig,
  patchAdvisorConfig,
} from "../src/config/options.ts";

describe("Advisor config", () => {
  test("defaults to disabled with setup available", () => {
    const config = normalizeAdvisorConfig({}, "/config.json");
    expect(config).toEqual({
      configPath: "/config.json",
      enabled: false,
      setupDismissed: false,
      configured: false,
    });
    expect(DEFAULT_ADVISOR_CONFIG).toEqual({
      enabled: false,
      setupDismissed: false,
    });
  });

  test("decodes only the approved persisted fields", () => {
    const config = normalizeAdvisorConfig(
      {
        enabled: true,
        provider: " provider ",
        model: " model ",
        setupDismissed: true,
      },
      "/config.json",
    );
    expect(config).toEqual({
      configPath: "/config.json",
      enabled: true,
      provider: "provider",
      model: "model",
      setupDismissed: true,
      configured: true,
    });
  });

  test("ignores fields outside the strict persisted contract", () => {
    const config = normalizeAdvisorConfig(
      {
        enabled: true,
        mode: "coach",
        futureRuntimeOptions: { experimental: true },
      },
      "/config.json",
    );
    expect(config).toEqual({
      configPath: "/config.json",
      enabled: true,
      setupDismissed: false,
      configured: false,
    });
  });

  test("recovers invalid fields independently", () => {
    expect(
      normalizeAdvisorConfig(
        { enabled: "yes", provider: "p", model: "m", setupDismissed: 1 },
        "/config.json",
      ),
    ).toEqual({
      configPath: "/config.json",
      enabled: false,
      provider: "p",
      model: "m",
      setupDismissed: false,
      configured: true,
    });
  });

  test("patches current fields, scrubs removed fields, and preserves unrelated data", () => {
    expect(
      patchAdvisorConfig(
        {
          future: { keep: true },
          mode: "review",
          reviewPolicy: "advisory",
          fastMode: true,
          thinkingLevel: "high",
          timeoutMs: 1,
          maxContextChars: 2,
        },
        {
          enabled: true,
          provider: "p",
          model: "m",
          setupDismissed: true,
        },
      ),
    ).toEqual({
      future: { keep: true },
      enabled: true,
      provider: "p",
      model: "m",
      setupDismissed: true,
    });
  });

  it.effect(
    "supports legacy document updates but rejects atomic publication without modifyObject",
    () =>
      Effect.gen(function* () {
        const path = "/config/advisor.json";
        const documents = makeInMemoryDocuments({ [path]: { future: { keep: true } } });
        const legacy = JsonDocumentStore.of({
          exists: documents.service.exists,
          readObject: documents.service.readObject,
          writeObject: documents.service.writeObject,
          updateObject: documents.service.updateObject,
        });
        const dependencies = Layer.mergeAll(
          Layer.succeed(JsonDocumentStore, legacy),
          Path.layer,
          FileSystem.layerNoop({
            exists: () => Effect.succeed(true),
            makeDirectory: () => Effect.void,
          }),
        );
        const next = yield* writeAdvisorConfigPatchEffect({ enabled: true }, path).pipe(
          Effect.provide(dependencies),
        );
        expect(next.enabled).toBe(true);
        expect(documents.documents.get(path)).toEqual({ future: { keep: true }, enabled: true });
        let published = false;
        const error = yield* writeAdvisorConfigPatchEffect({ enabled: false }, path, () =>
          Effect.sync(() => {
            published = true;
          }),
        ).pipe(Effect.provide(dependencies), Effect.flip);
        expect(error._tag).toBe("AdvisorConfigError");
        expect(published).toBe(false);
        expect(documents.documents.get(path)?.enabled).toBe(true);
      }),
  );

  test("clearing model fields removes them", () => {
    expect(
      patchAdvisorConfig(
        { provider: "p", model: "m", enabled: true },
        {
          provider: undefined,
          model: undefined,
          enabled: false,
        },
      ),
    ).toEqual({ enabled: false });
  });
});
