// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { JsonDocumentStore, nodePlatformLayer } from "pi-cosmic-core";
import { _test } from "../index.ts";
import {
  SETTINGS_OPTION_DESCRIPTORS,
  applySettingToRawConfig,
  configPaths,
  readConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "../src/config.ts";

const directories: string[] = [];
const temp = () => {
  const value = mkdtempSync(join(tmpdir(), "pi-better-openai-config-"));
  directories.push(value);
  return value;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const run = <A, E>(effect: Effect.Effect<A, E, Path.Path | JsonDocumentStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(nodePlatformLayer)));

describe("config helpers", () => {
  test("exposes expected defaults and fixed allow-list", () => {
    expect(_test.CONFIG_BASENAME).toBe("pi-better-openai.json");
    expect(_test.DEFAULT_CONFIG.desiredActive).toBe(false);
    expect(_test.DEFAULT_IMAGE_CONFIG.defaultSave).toBe("project");
    expect(_test.DEFAULT_CONFIG).not.toHaveProperty("supportedModels");
    expect(_test.SUPPORTED_FAST_MODELS).toContain("openai/gpt-5.5");
  });

  test("does not expose the allow-list through decoded config", async () => {
    const configPath = join(temp(), "config.json");
    await run(writeConfig(configPath, { supportedModels: ["openai/gpt-4.1"] }));
    expect(await run(readConfig(configPath))).not.toHaveProperty("supportedModels");
  });

  test("builds paths from injected SDK directories", async () => {
    expect(await run(configPaths("/project", "/agent"))).toEqual({
      project: "/project/.pi/extensions/pi-better-openai.json",
      global: "/agent/extensions/pi-better-openai.json",
    });
  });

  test("preserves unknown fields through Effect document writes", async () => {
    const configPath = join(temp(), "config.json");
    await run(
      writeConfig(configPath, {
        active: false,
        unknownField: "keep me",
        usage: { enabled: true, unknownUsageField: 123 },
      }),
    );
    const current = await run(readRawConfig(configPath));
    await run(writeConfig(configPath, { ...current, active: true }));
    const after = await run(readRawConfig(configPath));
    expect(after).toMatchObject({ active: true, unknownField: "keep me" });
    expect(after.usage).toEqual({ enabled: true, unknownUsageField: 123 });
  });

  test("project overrides global while global fills missing nested values", async () => {
    const root = temp();
    const cwd = join(root, "project");
    const agent = join(root, "agent");
    const paths = await run(configPaths(cwd, agent));
    await run(
      writeConfig(paths.global, {
        usage: { enabled: false, refreshIntervalMs: 20_000, showResetTimes: false },
        footer: { mode: "replace" },
        image: { defaultSave: "global", outputFormat: "jpeg", timeoutMs: 40_000 },
      }),
    );
    await run(
      writeConfig(paths.project, {
        usage: { enabled: true },
        footer: { mode: "status" },
        image: { outputFormat: "webp" },
      }),
    );
    const resolved = await run(resolveConfig(cwd, agent));
    expect(resolved.usage).toMatchObject({
      enabled: true,
      refreshIntervalMs: 20_000,
      showResetTimes: false,
    });
    expect(resolved.footer.mode).toBe("status");
    expect(resolved.image).toMatchObject({
      defaultSave: "global",
      outputFormat: "webp",
      timeoutMs: 40_000,
    });
  });

  test("invalid siblings fall back independently", async () => {
    const configPath = join(temp(), "config.json");
    await run(
      writeConfig(configPath, {
        footer: { mode: "float" },
        image: { enabled: true, defaultSave: "desktop", outputFormat: "gif" },
      }),
    );
    const parsed = await run(readConfig(configPath));
    expect(parsed?.footer).toBeUndefined();
    expect(parsed?.image).toEqual({ enabled: true });
  });

  test("clamps numeric settings", async () => {
    const root = temp();
    const paths = await run(configPaths(root, join(root, "agent")));
    await run(
      writeConfig(paths.project, { usage: { refreshIntervalMs: 1 }, image: { timeoutMs: 1 } }),
    );
    const resolved = await run(resolveConfig(root, join(root, "agent")));
    expect(resolved.usage.refreshIntervalMs).toBe(15_000);
    expect(resolved.image.timeoutMs).toBe(30_000);
  });

  test.each([
    ["usage.enabled", "true", true],
    ["usage.refreshIntervalMs", "15000", 15_000],
    ["usage.showResetTimes", "false", false],
    ["footer.mode", "status", "status"],
    ["image.defaultSave", "global", "global"],
    ["image.timeoutMs", "45000", 45_000],
  ])("parses setting %s from its persisted string form", (id, raw, expected) => {
    const descriptors = new Map(SETTINGS_OPTION_DESCRIPTORS.map((value) => [value.id, value]));
    expect(descriptors.get(id)?.parse(raw)).toBe(expected);
  });

  test("settings patches preserve unknown shapes", () => {
    const raw = { unknown: "preserved", usage: { unknownUsage: true } };
    expect(
      applySettingToRawConfig(raw, "fast.enabled", "true", {
        persistState: true,
        active: true,
        desiredActive: true,
      }),
    ).toMatchObject({ active: true, desiredActive: true, unknown: "preserved" });
    expect(applySettingToRawConfig(raw, "usage.refreshIntervalMs", "15000").usage).toEqual({
      unknownUsage: true,
      refreshIntervalMs: 15_000,
    });
  });
});
