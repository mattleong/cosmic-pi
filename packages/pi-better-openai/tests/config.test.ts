import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nodePlatformLayer } from "pi-cosmic-core";
import { configPaths, resolveConfig, writeConfig } from "../src/config/store.ts";

const configRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-better-openai-config-" });
  const agent = (yield* Path.Path).join(root, "agent");
  return { root, agent, paths: yield* configPaths(root, agent) };
});

layer(nodePlatformLayer)("config helpers", (it) => {
  it.effect("ignores untrusted project configuration and selects the global document", () =>
    Effect.gen(function* () {
      const { root, agent, paths } = yield* configRoot;
      yield* writeConfig(paths.global, { usage: { showResetTimes: true } });
      yield* writeConfig(paths.project, { usage: { showResetTimes: false } });

      const resolved = yield* resolveConfig(root, agent, false);
      expect(resolved.configPath).toBe(paths.global);
      expect(resolved.projectConfigExists).toBe(false);
      expect(resolved.usage.showResetTimes).toBe(true);
    }),
  );
});
