import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodePlatformLayer, InvalidSettingError, type JsonObject } from "pi-cosmic-core";
import { prepareSettingUpdate } from "../src/config/options.ts";
import type { ConfigFile } from "../src/config/schema.ts";
import {
  configPaths,
  readConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "../src/config/store.ts";

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
    [
      "project desiredActive",
      { desiredActive: false, active: true },
      { desiredActive: true, active: true },
      false,
    ],
    ["project legacy active", { active: true }, { desiredActive: false }, true],
    ["global desiredActive", undefined, { desiredActive: false, active: true }, false],
    ["global legacy active", undefined, { active: true }, true],
    ["default", undefined, undefined, false],
  ] as const)(
    "resolves desired fast state with legacy precedence from %s",
    ([, project, global, expected]) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* temp;
        const agent = path.join(root, "agent");
        const paths = yield* configPaths(root, agent);
        if (project) yield* writeConfig(paths.project, project satisfies ConfigFile);
        if (global) yield* writeConfig(paths.global, global satisfies ConfigFile);

        const resolved = yield* resolveConfig(root, agent, true);
        expect(resolved.desiredActive).toBe(expected);
      }),
  );

  it.effect("patches the exact path for every setting id", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string, JsonObject]> = [
        ["persistState", "false", { persistState: false }],
        ["compaction.enabled", "true", { compaction: { enabled: true } }],
        ["footer.mode", "status", { footer: { mode: "status" } }],
        ["usage.enabled", "true", { usage: { enabled: true } }],
        ["usage.refreshIntervalMs", "15000", { usage: { refreshIntervalMs: 15_000 } }],
        [
          "usage.showOnlyOnSubscriptionModels",
          "false",
          { usage: { showOnlyOnSubscriptionModels: false } },
        ],
        ["usage.showResetTimes", "false", { usage: { showResetTimes: false } }],
        ["image.enabled", "false", { image: { enabled: false } }],
        ["image.defaultModel", " custom-model ", { image: { defaultModel: " custom-model " } }],
        ["image.defaultSave", "global", { image: { defaultSave: "global" } }],
        ["image.outputFormat", "webp", { image: { outputFormat: "webp" } }],
        ["image.timeoutMs", "45000", { image: { timeoutMs: 45_000 } }],
      ];
      for (const [id, raw, expected] of cases) {
        const update = yield* prepareSettingUpdate(id, raw);
        expect(update({})).toEqual(expected);
      }
    }),
  );

  it.effect("rejects invalid booleans, numbers, and enums", () =>
    Effect.gen(function* () {
      for (const [id, value] of [
        ["usage.enabled", "yes"],
        ["usage.refreshIntervalMs", "NaN"],
        ["footer.mode", "other"],
        ["compaction.enabled", "sometimes"],
        ["image.defaultModel", " \t"],
      ] as const) {
        const failure = yield* prepareSettingUpdate(id, value).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(InvalidSettingError);
        expect(failure).toMatchObject({ id, message: `Invalid value for ${id}.` });
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
