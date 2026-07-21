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
  test("does not expose the allow-list through decoded config", async () => {
    const configPath = join(temp(), "config.json");
    await run(writeConfig(configPath, { supportedModels: ["openai/gpt-4.1"] }));
    expect(await run(readConfig(configPath))).not.toHaveProperty("supportedModels");
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

  test("ignores untrusted project configuration and selects the global document", async () => {
    const root = temp();
    const cwd = join(root, "project");
    const agent = join(root, "agent");
    const paths = await run(configPaths(cwd, agent));
    await run(writeConfig(paths.global, { usage: { enabled: true }, footer: { mode: "status" } }));
    await run(
      writeConfig(paths.project, { usage: { enabled: false }, footer: { mode: "replace" } }),
    );

    const resolved = await run(resolveConfig(cwd, agent, false));
    expect(resolved.configPath).toBe(paths.global);
    expect(resolved.projectConfigExists).toBe(false);
    expect(resolved.usage.enabled).toBe(true);
    expect(resolved.footer.mode).toBe("status");
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
  ])("parses setting %s from its persisted string form", async (id, raw, expected) => {
    const descriptors = new Map(SETTINGS_OPTION_DESCRIPTORS.map((value) => [value.id, value]));
    expect(await Effect.runPromise(descriptors.get(id)!.decode(raw))).toBe(expected);
  });

  test("rejects invalid booleans, numbers, and enums", async () => {
    for (const [id, value] of [
      ["usage.enabled", "yes"],
      ["usage.refreshIntervalMs", "NaN"],
      ["footer.mode", "other"],
    ] as const) {
      await expect(Effect.runPromise(applySettingToRawConfig({}, id, value))).rejects.toBeDefined();
    }
  });

  test("settings patches preserve unknown shapes", async () => {
    const raw = { unknown: "preserved", usage: { unknownUsage: true } };
    expect(
      await Effect.runPromise(
        applySettingToRawConfig(raw, "fast.enabled", "true", {
          persistState: true,
          active: true,
          desiredActive: true,
        }),
      ),
    ).toMatchObject({ active: true, desiredActive: true, unknown: "preserved" });
    const usage = await Effect.runPromise(
      applySettingToRawConfig(raw, "usage.refreshIntervalMs", "15000"),
    );
    expect(usage.usage).toEqual({ unknownUsage: true, refreshIntervalMs: 15_000 });
  });
});
