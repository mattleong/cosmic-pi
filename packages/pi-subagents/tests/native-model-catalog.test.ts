// Native fixture process is an intentional integration-test boundary.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import {
  makeNativeModelCatalog,
  NativeModelCatalogError,
} from "../src/boundary/native-model-catalog.ts";
import { prepareCodexCatalogHarness } from "../src/boundary/local-cli-process.ts";

const fixture = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
};

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

  it("isolates Codex discovery from user config while copying bounded auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-catalog-test-"));
    const agentDirectory = join(root, "agent");
    const sourceHome = join(root, "source-codex");
    await mkdir(agentDirectory);
    await mkdir(sourceHome);
    await writeFile(join(sourceHome, "auth.json"), `${JSON.stringify({ token: "fixture" })}\n`);
    try {
      const harness = await prepareCodexCatalogHarness({
        agentDirectory,
        environment: {
          HOME: root,
          PATH: process.env.PATH,
          CODEX_HOME: sourceHome,
        },
      });
      const codexHome = harness.env.CODEX_HOME!;
      expect(codexHome).not.toBe(sourceHome);
      expect(harness.args).toEqual(["app-server", "--stdio", "--strict-config"]);
      expect(JSON.parse(await readFile(join(codexHome, "auth.json"), "utf8"))).toEqual({
        token: "fixture",
      });
      const config = await readFile(join(codexHome, "config.toml"), "utf8");
      expect(config).toContain("apps = false");
      expect(config).toContain("plugins = false");
      expect(config).not.toContain("mcp_servers");
      await harness.release();
      await expect(readFile(join(codexHome, "config.toml"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("cancels and cleans up an in-flight catalog process", async () => {
    const home = await mkdtemp(join(tmpdir(), "hanging-catalog-"));
    try {
      const hanging = makeNativeModelCatalog({
        executables: { claude: fixture, codex: fixture },
        environment: { HOME: home, PATH: process.env.PATH },
        timeoutMillis: 10_000,
      });
      const fiber = Effect.runFork(hanging.list("claude", process.cwd()));
      let pid: number | undefined;
      for (let attempt = 0; attempt < 50 && pid === undefined; attempt += 1) {
        try {
          pid = Number(await readFile(join(home, "fixture.pid"), "utf8"));
        } catch {
          await delay(10);
        }
      }
      expect(pid).toBeGreaterThan(0);
      await Effect.runPromise(Fiber.interrupt(fiber));
      for (let attempt = 0; attempt < 50 && pid && processExists(pid); attempt += 1)
        await delay(10);
      expect(pid && processExists(pid)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects catalog text containing terminal control sequences", async () => {
    const unsafe = makeNativeModelCatalog({
      executables: { claude: fixture, codex: fixture },
      environment: { HOME: "/tmp/unsafe-catalog", PATH: process.env.PATH },
    });
    await expect(Effect.runPromise(unsafe.list("claude", process.cwd()))).rejects.toMatchObject({
      code: "catalog_protocol_invalid",
    });
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
