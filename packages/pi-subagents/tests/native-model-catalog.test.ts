// Native fixture process is an intentional integration-test boundary.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  makeNativeModelCatalog,
  NativeModelCatalogError,
} from "../src/boundary/native-model-catalog.ts";

const fixture = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));

const catalog = () =>
  makeNativeModelCatalog({
    executables: { claude: fixture, codex: fixture },
    environment: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C" },
  });

describe("native model catalog boundary", () => {
  it("loads bounded Claude initialize-advertised models without inference", async () => {
    const models = await Effect.runPromise(catalog().list("claude", process.cwd()));
    expect(models).toEqual([
      {
        selector: "default",
        label: "Default Claude",
        description: "Fixture default model",
        supportedEfforts: ["low", "medium", "high"],
        isDefault: true,
      },
      {
        selector: "sonnet",
        label: "Claude Sonnet",
        description: "Fixture efficient model",
        supportedEfforts: ["low", "high"],
        isDefault: false,
      },
    ]);
  });

  it("loads bounded Codex model/list results and reasoning efforts", async () => {
    const models = await Effect.runPromise(catalog().list("codex", process.cwd()));
    expect(models.map((model) => model.selector)).toEqual([
      "gpt-fixture-default",
      "gpt-fixture-fast",
    ]);
    expect(models[0]).toMatchObject({
      label: "GPT Fixture Default",
      supportedEfforts: ["low", "high"],
      isDefault: true,
    });
    expect(models[1]).toMatchObject({ supportedEfforts: ["minimal"] });
  });

  it("returns a typed error when the native executable is unavailable", async () => {
    const missing = makeNativeModelCatalog({
      executables: { claude: "/definitely/missing/claude", codex: fixture },
      environment: { HOME: process.env.HOME, PATH: process.env.PATH },
      timeoutMillis: 100,
    });
    await expect(Effect.runPromise(missing.list("claude", process.cwd()))).rejects.toBeInstanceOf(
      NativeModelCatalogError,
    );
  });
});
