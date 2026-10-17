import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { signalProcess } from "pi-cosmic-core";
import {
  NativeModelCatalog,
  type NativeModelCatalogContract,
  type NativeModelCatalogLayerOptions,
} from "../src/boundary/native-model-catalog.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import { processAlive } from "./support/process-liveness.ts";

const makeNativeModelCatalog = (options: NativeModelCatalogLayerOptions) =>
  Effect.provide(NativeModelCatalog, NativeModelCatalog.layer(options));

const fixture = fileURLToPath(new URL("./fixtures/model-catalog-fixture.ts", import.meta.url));
const setup = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-subagents-catalog-");
  const home = yield* step(() => fs.realpath(directory));
  const executable = fixture;
  yield* step(() => fs.mkdir(nodePath.join(home, ".claude")));
  const cwd = nodePath.join(home, "project");
  yield* step(() => fs.mkdir(nodePath.join(cwd, ".claude"), { recursive: true }));
  yield* step(() =>
    fs.writeFile(nodePath.join(cwd, ".claude", "settings.json"), '{"model":"project-model"}'),
  );
  const path = yield* Config.String("PATH").pipe(Effect.orDie);
  return {
    home,
    cwd,
    settings: nodePath.join(home, ".claude", "settings.json"),
    options: {
      executables: { claude: executable, codex: executable },
      environment: {
        HOME: home,
        PATH: path,
        CLAUDE_CONFIG_DIR: nodePath.join(cwd, ".claude"),
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
  it.live("reaps a catalog descendant that outlives its terminated leader", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* setup;
        const descendantFixture = fileURLToPath(
          new URL("./fixtures/model-catalog-descendant-fixture.ts", import.meta.url),
        );
        const pidFile = nodePath.join(test.cwd, "catalog-descendant.pid");
        yield* Effect.addFinalizer(() =>
          step(() => fs.readFile(pidFile, "utf8")).pipe(
            Effect.map((pid) => signalProcess(Number(pid), "SIGKILL")),
            Effect.ignoreCause,
          ),
        );
        const catalog = yield* makeNativeModelCatalog({
          ...test.options,
          executables: { claude: descendantFixture, codex: descendantFixture },
        });
        yield* catalog.list("claude", test.cwd).pipe(Effect.orDie);
        const pid = Number(yield* step(() => fs.readFile(pidFile, "utf8")));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        expect(processAlive(pid)).toBe(false);
      }),
    ),
  );
  effectTest("falls back for malformed, oversized, and unsafe user settings", function* () {
    const test = yield* setup;
    const catalog = yield* makeNativeModelCatalog(test.options);
    expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
    for (const settings of [
      "{",
      '{"model":"--settings"}',
      '{"model":"model;command"}',
      JSON.stringify({ model: "bad\nselector" }),
      JSON.stringify({ model: "oversized", padding: "x".repeat(64 * 1024) }),
    ]) {
      yield* step(() => fs.writeFile(test.settings, settings));
      expect(yield* selectorAt(catalog, test.cwd, 2)).toBe("default");
    }
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
