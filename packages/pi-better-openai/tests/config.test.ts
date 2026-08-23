import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodePlatformLayer } from "pi-cosmic-core";
import {
  InvalidSettingError,
  SETTINGS_OPTION_DESCRIPTORS,
  prepareSettingUpdate,
  configPaths,
  readConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "../src/config/index.ts";

const temp = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "pi-better-openai-config-" })),
);

layer(nodePlatformLayer)("config helpers", (it) => {
  it.effect("preserves unknown fields through Effect document writes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const configPath = path.join(yield* temp, "config.json");
      yield* writeConfig(configPath, {
        active: false,
        unknownField: "keep me",
        usage: { enabled: true, unknownUsageField: 123 },
      });
      const current = yield* readRawConfig(configPath);
      yield* writeConfig(configPath, { ...current, active: true });
      const after = yield* readRawConfig(configPath);
      expect(after).toMatchObject({ active: true, unknownField: "keep me" });
      expect(after.usage).toEqual({ enabled: true, unknownUsageField: 123 });
    }),
  );

  it.effect("ignores untrusted project configuration and selects the global document", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temp;
      const cwd = path.join(root, "project");
      const agent = path.join(root, "agent");
      const paths = yield* configPaths(cwd, agent);
      yield* writeConfig(paths.global, { usage: { enabled: true }, footer: { mode: "status" } });
      yield* writeConfig(paths.project, { usage: { enabled: false }, footer: { mode: "replace" } });

      const resolved = yield* resolveConfig(cwd, agent, false);
      expect(resolved.configPath).toBe(paths.global);
      expect(resolved.projectConfigExists).toBe(false);
      expect(resolved.usage.enabled).toBe(true);
      expect(resolved.footer.mode).toBe("status");
    }),
  );

  it.effect("invalid siblings fall back independently", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const configPath = path.join(yield* temp, "config.json");
      yield* writeConfig(configPath, {
        footer: { mode: "float" },
        image: { enabled: true, defaultSave: "desktop", outputFormat: "gif" },
      });
      const parsed = yield* readConfig(configPath);
      expect(parsed?.footer).toBeUndefined();
      expect(parsed?.image).toEqual({ enabled: true });
    }),
  );

  it.effect("clamps numeric settings", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* temp;
      const paths = yield* configPaths(root, path.join(root, "agent"));
      yield* writeConfig(paths.project, {
        usage: { refreshIntervalMs: 1 },
        image: { timeoutMs: 1 },
      });
      const resolved = yield* resolveConfig(root, path.join(root, "agent"), true);
      expect(resolved.usage.refreshIntervalMs).toBe(15_000);
      expect(resolved.image.timeoutMs).toBe(30_000);
    }),
  );

  it.effect.each([
    ["usage.enabled", "true", true],
    ["usage.refreshIntervalMs", "15000", 15_000],
    ["usage.showResetTimes", "false", false],
    ["footer.mode", "status", "status"],
    ["compaction.enabled", "true", true],
    ["image.defaultSave", "global", "global"],
    ["image.timeoutMs", "45000", 45_000],
  ] as const)("parses setting %s from its persisted string form", ([id, raw, expected]) =>
    Effect.gen(function* () {
      const descriptors = new Map(SETTINGS_OPTION_DESCRIPTORS.map((value) => [value.id, value]));
      expect(yield* descriptors.get(id)!.decode(raw)).toBe(expected);
    }),
  );

  it.effect("rejects invalid booleans, numbers, and enums", () =>
    Effect.gen(function* () {
      for (const [id, value] of [
        ["usage.enabled", "yes"],
        ["usage.refreshIntervalMs", "NaN"],
        ["footer.mode", "other"],
        ["compaction.enabled", "sometimes"],
      ] as const) {
        const failure = yield* prepareSettingUpdate(id, value).pipe(Effect.flip);
        expect(failure).toBeDefined();
      }
    }),
  );

  it.effect("rejects unknown setting ids with the typed error", () =>
    Effect.gen(function* () {
      const failure = yield* prepareSettingUpdate("usage.nonexistent", "true").pipe(Effect.flip);
      expect(failure).toBeInstanceOf(InvalidSettingError);
    }),
  );

  it.effect("settings patches preserve unknown shapes", () =>
    Effect.gen(function* () {
      const raw = { unknown: "preserved", usage: { unknownUsage: true } };
      const usageUpdate = yield* prepareSettingUpdate("usage.refreshIntervalMs", "15000");
      expect(usageUpdate(raw)).toMatchObject({ unknown: "preserved" });
      expect(usageUpdate(raw).usage).toEqual({ unknownUsage: true, refreshIntervalMs: 15_000 });
    }),
  );
});
