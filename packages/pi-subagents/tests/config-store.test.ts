// Node filesystem setup is a test boundary for the live JSON-document Layer.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  SubagentConfigStore,
  type SubagentConfigStoreShape,
  subagentConfigStoreLayer,
} from "../src/config/store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const layer = subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer));
const withStore = <A, E>(f: (store: SubagentConfigStoreShape) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(SubagentConfigStore, f).pipe(Effect.provide(layer)));

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  roots.push(root);
  const agentDirectory = join(root, "agent");
  const cwd = join(root, "repo");
  await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  return {
    cwd,
    agentDirectory,
    globalPath: join(agentDirectory, "pi-subagents.json"),
    projectPath: join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
  };
};

describe("SubagentConfigStore v4", () => {
  it("loads v4 global/project routes with project inheritance", async () => {
    const paths = await fixture();
    await writeFile(
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
    );
    await writeFile(paths.projectPath, JSON.stringify({ version: 4, defaultProfile: "worker" }));
    const config = await withStore((store) => store.load(paths.cwd, paths.agentDirectory, true));
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
    expect(config.defaultProfile).toBe("worker");
  });

  it("accepts only v4 documents and never reads an untrusted project", async () => {
    const paths = await fixture();
    for (const value of [{ version: 1 }, { version: 2 }, {}, { version: "4" }]) {
      await writeFile(paths.globalPath, JSON.stringify(value));
      await expect(
        withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
      ).rejects.toMatchObject({
        operation: "activate",
        path: paths.globalPath,
      });
    }
    await writeFile(
      paths.globalPath,
      JSON.stringify({ version: 3, denied: [{ backend: "pi", model: "legacy" }] }),
    );
    await expect(
      withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
    ).rejects.toMatchObject({
      operation: "activate",
      message: expect.stringContaining("remove denied/discouraged"),
    });
    await writeFile(paths.globalPath, JSON.stringify({ version: 4 }));
    await writeFile(paths.projectPath, "{ not json");
    const config = await withStore((store) => store.load(paths.cwd, paths.agentDirectory, false));
    expect(config.projectConfigExists).toBe(false);
  });

  it("fails closed on invalid JSON", async () => {
    const paths = await fixture();
    await writeFile(paths.globalPath, "{ not json");
    await expect(
      withStore((store) => store.load(paths.cwd, paths.agentDirectory, true)),
    ).rejects.toMatchObject({
      operation: "read",
      path: paths.globalPath,
    });
  });

  it("atomically patches one profile while preserving unrelated fields and routes", async () => {
    const paths = await fixture();
    const initial = {
      version: 4,
      defaultProfile: "planner",
      customFutureField: { retained: true },
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
    await writeFile(paths.globalPath, JSON.stringify(initial));
    const inspection = await withStore((store) =>
      store.inspect(paths.cwd, paths.agentDirectory, true),
    );
    await withStore((store) =>
      store.patchProfile(paths.cwd, paths.agentDirectory, {
        scope: "global",
        profile: "scout",
        route: {
          host: "local",
          runtime: "pi",
          model: "openai/new",
          effort: "low",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
        expectedExists: true,
        expectedDocument: inspection.globalDocument,
        projectTrusted: true,
      }),
    );
    const saved = JSON.parse(await readFile(paths.globalPath, "utf8"));
    expect(saved.defaultProfile).toBe("planner");
    expect(saved.customFutureField).toEqual({ retained: true });
    expect(saved.profiles.reviewer).toEqual(initial.profiles.reviewer);
    expect(saved.profiles.scout).toEqual({
      host: "local",
      runtime: "pi",
      model: "openai/new",
      effort: "low",
      context: "fresh",
      writeIntent: "read-only",
      closeOnReport: true,
    });
  });

  it("removes inherited routes and rejects untrusted project writes", async () => {
    const paths = await fixture();
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
    await writeFile(paths.projectPath, JSON.stringify(project));
    const inspection = await withStore((store) =>
      store.inspect(paths.cwd, paths.agentDirectory, true),
    );
    await expect(
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "project",
          profile: "worker",
          expectedExists: true,
          expectedDocument: inspection.projectDocument,
          projectTrusted: false,
        }),
      ),
    ).rejects.toMatchObject({ operation: "update", path: paths.projectPath });
    await withStore((store) =>
      store.patchProfile(paths.cwd, paths.agentDirectory, {
        scope: "project",
        profile: "worker",
        expectedExists: true,
        expectedDocument: inspection.projectDocument,
        projectTrusted: true,
      }),
    );
    const saved = JSON.parse(await readFile(paths.projectPath, "utf8"));
    expect(saved.profiles.worker).toBeUndefined();
    expect(saved.profiles.reviewer).toBe("disabled");
  });

  it("treats removal patches with no backing file or key as true no-ops", async () => {
    const paths = await fixture();
    await withStore((store) =>
      store.patchProfile(paths.cwd, paths.agentDirectory, {
        scope: "project",
        profile: "worker",
        expectedExists: false,
        projectTrusted: true,
      }),
    );
    await expect(readFile(paths.projectPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await withStore((store) =>
      store.patchProfile(paths.cwd, paths.agentDirectory, {
        scope: "global",
        profile: "worker",
        expectedExists: false,
        projectTrusted: true,
      }),
    );
    await expect(readFile(paths.globalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rewrite an existing document when the patch changes nothing", async () => {
    const paths = await fixture();
    const raw = JSON.stringify({ version: 4, defaultProfile: "planner" });
    await writeFile(paths.globalPath, raw);
    const inspection = await withStore((store) =>
      store.inspect(paths.cwd, paths.agentDirectory, true),
    );
    await withStore((store) =>
      store.patchProfile(paths.cwd, paths.agentDirectory, {
        scope: "global",
        profile: "worker",
        expectedExists: true,
        expectedDocument: inspection.globalDocument,
        projectTrusted: true,
      }),
    );
    expect(await readFile(paths.globalPath, "utf8")).toBe(raw);
  });

  it("detects external edits instead of clobbering them", async () => {
    const paths = await fixture();
    await writeFile(paths.globalPath, JSON.stringify({ version: 4, defaultProfile: "worker" }));
    const inspection = await withStore((store) =>
      store.inspect(paths.cwd, paths.agentDirectory, true),
    );
    await writeFile(paths.globalPath, JSON.stringify({ version: 4, defaultProfile: "reviewer" }));
    await expect(
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
    ).rejects.toMatchObject({ operation: "update", path: paths.globalPath });
    expect(JSON.parse(await readFile(paths.globalPath, "utf8")).defaultProfile).toBe("reviewer");
  });
});
