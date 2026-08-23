// Node filesystem setup is a test boundary for the live JSON-document Layer.
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer, provideBuiltLayer } from "pi-cosmic-core";
import { afterEach, describe, expect } from "vitest";
import {
  SubagentConfigStore,
  type SubagentConfigStoreContract,
  subagentConfigStoreLayer,
} from "../src/config/store.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const { mkdir, mkdtemp, readFile, rm, writeFile } = nodeFsPromises;
const { join } = nodePath;

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))).then(
    () => undefined,
  ),
);
const layer = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
const withStore = <A, E>(f: (store: SubagentConfigStoreContract) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(SubagentConfigStore, f).pipe(provideBuiltLayer(layer)));

const fixture = () =>
  mkdtemp(join(tmpdir(), "pi-subagents-config-")).then((root) => {
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    return mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true })
      .then(() => mkdir(agentDirectory, { recursive: true }))
      .then(() => ({
        cwd,
        agentDirectory,
        globalPath: join(agentDirectory, "pi-subagents.json"),
        projectPath: join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
      }));
  });

describe("SubagentConfigStore v4", () => {
  effectTest("loads v4 global/project routes with project inheritance", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 4,
          profiles: {
            worker: {
              host: "local",
              runtime: "pi",
              model: "openai/worker",
              effort: "high",
              context: "fresh",
              writeIntent: "writer",
              closeOnReport: true,
            },
          },
        }),
      ),
    );
    yield* step(() => writeFile(paths.projectPath, JSON.stringify({ version: 4 })));
    const config = yield* step(() =>
      withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
    );
    expect(config.profiles.worker).toEqual({
      candidates: [
        {
          host: "local",
          runtime: "pi",
          model: "openai/worker",
          effort: "high",
          context: "fresh",
          writeIntent: "writer",
          fastMode: false,
          closeOnReport: true,
        },
      ],
    });
    expect(config.profileSources.worker).toBe("global");
    expect(config.fallbackProfile).toBe("generalist");
  });

  effectTest("accepts only v4 documents and never reads an untrusted project", function* () {
    const paths = yield* step(fixture);
    for (const value of [{ version: 1 }, { version: 2 }, {}, { version: "4" }]) {
      yield* step(() => writeFile(paths.globalPath, JSON.stringify(value)));
      yield* step(() =>
        expect(
          withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
        ).rejects.toMatchObject({
          operation: "activate",
          path: paths.globalPath,
        }),
      );
    }
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({ version: 3, denied: [{ backend: "pi", model: "legacy" }] }),
      ),
    );
    yield* step(() =>
      expect(
        withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
      ).rejects.toMatchObject({
        operation: "activate",
        message: expect.stringContaining("must declare version 4"),
      }),
    );
    yield* step(() => writeFile(paths.globalPath, JSON.stringify({ version: 4 })));
    yield* step(() => writeFile(paths.projectPath, "{ not json"));
    const config = yield* step(() =>
      withStore((store) => store.load(paths.cwd, paths.agentDirectory, false)),
    );
    expect(config.projectConfigExists).toBe(false);
  });

  effectTest("fails closed on invalid JSON", function* () {
    const paths = yield* step(fixture);
    yield* step(() => writeFile(paths.globalPath, "{ not json"));
    yield* step(() =>
      expect(
        withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
      ).rejects.toMatchObject({
        operation: "read",
        path: paths.globalPath,
      }),
    );
  });

  effectTest("atomically patches one profile while preserving unrelated routes", function* () {
    const paths = yield* step(fixture);
    const initial = {
      version: 4,
      profiles: {
        scout: {
          host: "local",
          runtime: "pi",
          model: "parent",
          effort: "default",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
        reviewer: [
          {
            host: "local",
            runtime: "pi",
            model: "openai/first",
            effort: "medium",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
          },
          {
            host: "local",
            runtime: "pi",
            model: "openai/second",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: true,
          },
        ],
      },
    };
    yield* step(() => writeFile(paths.globalPath, JSON.stringify(initial)));
    const inspection = yield* step(() =>
      withStore((store) => store.inspect(paths.cwd, paths.agentDirectory, true)),
    );
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "global",
          profile: "scout",
          route: {
            host: "local",
            runtime: "pi",
            model: "openai-codex/gpt-5.6-sol",
            effort: "low",
            context: "fresh",
            writeIntent: "read-only",
            fastMode: true,
            closeOnReport: true,
          },
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
          projectTrusted: true,
        }),
      ),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
    expect(saved.profiles.reviewer).toEqual(initial.profiles.reviewer);
    expect(saved.profiles.scout).toEqual({
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      context: "fresh",
      writeIntent: "read-only",
      fastMode: true,
      closeOnReport: true,
    });
    const refreshed = yield* step(() =>
      withStore((store) => store.inspect(paths.cwd, paths.agentDirectory, true)),
    );
    expect(refreshed.config.profiles.scout.candidates[0]?.fastMode).toBe(true);
  });

  effectTest("rejects unknown profile aliases and configuration fields", function* () {
    const paths = yield* step(fixture);
    for (const document of [
      { version: 4, defaultProfile: "generalist" },
      { version: 4, profiles: { delegate: "disabled" } },
      { version: 4, customFutureField: true },
    ]) {
      yield* step(() => writeFile(paths.globalPath, JSON.stringify(document)));
      yield* step(() =>
        expect(
          withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
        ).rejects.toMatchObject({ operation: "activate", path: paths.globalPath }),
      );
    }
  });

  effectTest("removes inherited routes and rejects untrusted project writes", function* () {
    const paths = yield* step(fixture);
    const project = {
      version: 4,
      profiles: {
        worker: {
          host: "local",
          runtime: "pi",
          model: "parent",
          effort: "default",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
        reviewer: "disabled",
      },
    };
    yield* step(() => writeFile(paths.projectPath, JSON.stringify(project)));
    const inspection = yield* step(() =>
      withStore((store) => store.inspect(paths.cwd, paths.agentDirectory, true)),
    );
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "project",
            profile: "worker",
            expectedExists: true,
            expectedDocument: inspection.projectDocument,
            projectTrusted: false,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.projectPath }),
    );
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "project",
          profile: "worker",
          expectedExists: true,
          expectedDocument: inspection.projectDocument,
          projectTrusted: true,
        }),
      ),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.projectPath, "utf8")));
    expect(saved.profiles.worker).toBeUndefined();
    expect(saved.profiles.reviewer).toBe("disabled");
  });

  effectTest("treats removal patches with no backing file or key as true no-ops", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "project",
          profile: "worker",
          expectedExists: false,
          projectTrusted: true,
        }),
      ),
    );
    yield* step(() =>
      expect(readFile(paths.projectPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" }),
    );
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "global",
          profile: "worker",
          expectedExists: false,
          projectTrusted: true,
        }),
      ),
    );
    yield* step(() =>
      expect(readFile(paths.globalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" }),
    );
  });

  effectTest("does not rewrite an existing document when the patch changes nothing", function* () {
    const paths = yield* step(fixture);
    const raw = JSON.stringify({ version: 4 });
    yield* step(() => writeFile(paths.globalPath, raw));
    const inspection = yield* step(() =>
      withStore((store) => store.inspect(paths.cwd, paths.agentDirectory, true)),
    );
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "global",
          profile: "worker",
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
          projectTrusted: true,
        }),
      ),
    );
    expect(yield* step(() => readFile(paths.globalPath, "utf8"))).toBe(raw);
  });

  effectTest("detects external edits instead of clobbering them", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 4,
          profiles: {
            scout: {
              host: "local",
              runtime: "pi",
              model: "parent",
              effort: "low",
              context: "fresh",
              writeIntent: "read-only",
            },
          },
        }),
      ),
    );
    const inspection = yield* step(() =>
      withStore((store) => store.inspect(paths.cwd, paths.agentDirectory, true)),
    );
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 4,
          profiles: {
            scout: {
              host: "local",
              runtime: "pi",
              model: "parent",
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
            },
          },
        }),
      ),
    );
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profile: "worker",
            route: "disabled",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
    expect(
      JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8"))).profiles.scout.effort,
    ).toBe("high");
  });
});
