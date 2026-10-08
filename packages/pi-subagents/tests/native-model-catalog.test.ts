// Live filesystem/process checks protect preference freshness and isolated no-inference discovery.
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import {
  makeNativeModelCatalog,
  type NativeModelCatalogContract,
} from "../src/boundary/native-model-catalog.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;
const fixture = fileURLToPath(new URL("./fixtures/model-catalog-fixture.mjs", import.meta.url));
const setup = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-subagents-catalog-");
  const home = yield* step(() => fs.realpath(directory));
  const executable = join(home, "catalog.mjs");
  yield* step(() => fs.copyFile(fixture, executable));
  yield* step(() => fs.chmod(executable, 0o700));
  yield* step(() => fs.mkdir(join(home, ".claude")));
  const cwd = join(home, "project");
  yield* step(() => fs.mkdir(join(cwd, ".claude"), { recursive: true }));
  yield* step(() =>
    fs.writeFile(join(cwd, ".claude", "settings.json"), '{"model":"project-model"}'),
  );
  const path = yield* Config.String("PATH").pipe(Effect.orDie);
  return {
    home,
    cwd,
    settings: join(home, ".claude", "settings.json"),
    options: {
      executables: { claude: executable, codex: executable },
      environment: {
        HOME: home,
        PATH: path,
        CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
        ANTHROPIC_API_KEY: "private-api-key",
      },
    },
  };
});
const selectorAt = (catalog: NativeModelCatalogContract, cwd: string, index: number) =>
  catalog.list("claude", cwd).pipe(
    Effect.orDie,
    Effect.map((models) => models[index]?.selector),
  );

describe("Claude catalog preference", () => {
  effectTest(
    "preserves both selectors and refreshes after user preference edits without reload",
    function* () {
      const test = yield* setup;
      yield* step(() =>
        fs.writeFile(
          test.settings,
          JSON.stringify({ model: "latest[1m]", hooks: { ignored: true } }),
        ),
      );
      const catalog = yield* makeNativeModelCatalog(test.options);
      const first = yield* catalog.list("claude", test.cwd).pipe(Effect.orDie);
      expect(first.map((model) => model.selector)).toEqual([
        "fixture-stable[1m]",
        "fixture-stable",
        "default",
        "fixture-next",
        "latest[1m]",
      ]);
      expect(first.map((model) => model.description)).toEqual([
        "Updated stable metadata",
        "Updated stable metadata",
        "Next release",
        "Next release",
        "Next release",
      ]);
      const cached = yield* catalog.list("claude", test.cwd).pipe(Effect.orDie);
      expect(cached).toBe(first);

      yield* step(() => fs.writeFile(test.settings, '{"model":"other-alias[1m]"}'));
      const updated = yield* catalog.list("claude", test.cwd).pipe(Effect.orDie);
      expect(updated.map((model) => model.selector)).toEqual([
        "fixture-stable[1m]",
        "fixture-stable",
        "default",
        "fixture-next",
        "other-alias[1m]",
      ]);
      yield* step(() => fs.unlink(test.settings));
      expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
    },
  );

  effectTest(
    "falls back for absent, malformed, oversized, and non-regular user settings",
    function* () {
      const test = yield* setup;
      const catalog = yield* makeNativeModelCatalog(test.options);
      expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
      for (const settings of [
        "{",
        "null",
        "[]",
        "{}",
        '{"model":1}',
        '{"model":""}',
        '{"model":"--settings"}',
        '{"model":"model;command"}',
        JSON.stringify({ model: "bad\nselector" }),
        JSON.stringify({ model: "x".repeat(257) }),
        JSON.stringify({ model: "oversized", padding: "x".repeat(64 * 1024) }),
      ]) {
        yield* step(() => fs.writeFile(test.settings, settings));
        expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
      }
      yield* step(() => fs.unlink(test.settings));
      yield* step(() => fs.symlink(join(test.home, "missing-settings.json"), test.settings));
      expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
      yield* step(() => fs.unlink(test.settings));
      yield* step(() => fs.mkdir(test.settings));
      expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
    },
  );

  effectTest(
    "follows the exact user settings symlink and rereads its regular target",
    function* () {
      const test = yield* setup;
      const target = join(test.home, "dotfile-settings.json");
      yield* step(() => fs.writeFile(target, '{"model":"dotfile-alias[1m]"}'));
      yield* step(() => fs.symlink(target, test.settings));
      const catalog = yield* makeNativeModelCatalog(test.options);
      expect(yield* selectorAt(catalog, test.cwd, 4)).toBe("dotfile-alias[1m]");
      yield* step(() => fs.writeFile(target, '{"model":"updated-dotfile[1m]"}'));
      expect(yield* selectorAt(catalog, test.cwd, 4)).toBe("updated-dotfile[1m]");
      yield* step(() => fs.writeFile(target, "malformed"));
      expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
    },
  );

  effectTest("lists each alias target as its own explicit model", function* () {
    const test = yield* setup;
    const catalog = yield* makeNativeModelCatalog(test.options);
    const defaultsOnly = yield* catalog.list("claude", test.cwd).pipe(Effect.orDie);
    // A target reached only through `default` is named by its model ID.
    expect(defaultsOnly.find((model) => model.selector === "fixture-next")).toMatchObject({
      label: "fixture-next",
      isDefault: false,
    });

    yield* step(() => fs.writeFile(test.settings, '{"model":"aliases"}'));
    const models = yield* catalog.list("claude", test.cwd).pipe(Effect.orDie);
    expect(
      models
        .filter((model) => !model.selector.startsWith("fixture-"))
        .map((model) => [model.selector, model.label, model.isDefault]),
    ).toEqual([
      ["default", "Default (recommended)", true],
      ["opus", "Next", false],
      ["model-next", "Next", false],
      ["sonnet", "Fast", false],
      ["model-fast", "Fast", false],
      ["model-older", "Older", false],
      ["legacy", "legacy", false],
    ]);
  });

  effectTest("redacts rejected preference probes and permits recovery", function* () {
    const test = yield* setup;
    yield* step(() => fs.writeFile(test.settings, '{"model":"reject"}'));
    const catalog = yield* makeNativeModelCatalog(test.options);
    const result = yield* catalog.list("claude", test.cwd).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("private-provider-diagnostic");
    expect(JSON.stringify(result)).not.toContain(test.home);
    expect(JSON.stringify(result)).not.toContain("private-api-key");
    yield* step(() => fs.writeFile(test.settings, '{"model":"recovered[1m]"}'));
    expect(yield* selectorAt(catalog, test.cwd, 4)).toBe("recovered[1m]");
  });
});
