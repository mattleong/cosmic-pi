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
import { BUILTIN_PROFILE_ROUTES } from "../src/profiles/definitions.ts";
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
        load: (trusted: boolean) => withStore((store) => store.load(cwd, agentDirectory, trusted)),
        inspect: (trusted: boolean) =>
          withStore((store) => store.inspect(cwd, agentDirectory, trusted)),
      }));
  });

describe("SubagentConfigStore v6", () => {
  effectTest("loads v4 routes with v6 nesting defaults and project inheritance", function* () {
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
    const config = yield* step(() => paths.load(true));
    expect(config.profiles.worker).toEqual({
      candidates: [
        {
          host: "local",
          runtime: "pi",
          model: "openai/worker",
          effort: "high",
          context: "fresh",
          writeIntent: "writer",
          closeOnReport: true,
        },
      ],
    });
    expect(config.profileSources.worker).toBe("global");
    expect(config.fallbackProfile).toBe("generalist");
    expect(config.nesting).toEqual({ maxDirectChildren: 12, maxDepth: 3 });
    expect(config.nestingSource).toBe("builtin");
  });

  effectTest("accepts v4/v5 documents and never reads an untrusted project", function* () {
    const paths = yield* step(fixture);
    for (const value of [{ version: 1 }, { version: 2 }, {}, { version: "4" }]) {
      yield* step(() => writeFile(paths.globalPath, JSON.stringify(value)));
      yield* step(() =>
        expect(paths.load(true)).rejects.toMatchObject({
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
      expect(paths.load(true)).rejects.toMatchObject({
        operation: "activate",
        message: expect.stringContaining("must declare version 4"),
      }),
    );
    yield* step(() => writeFile(paths.globalPath, JSON.stringify({ version: 4 })));
    yield* step(() => writeFile(paths.projectPath, "{ not json"));
    const config = yield* step(() => paths.load(false));
    expect(config.projectConfigExists).toBe(false);
  });

  effectTest("keeps invalid defaults loadable for fail-closed settings repair", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 6,
          defaultProfileSet: "missing",
          profileSets: { valid: { profiles: {} } },
        }),
      ),
    );
    const config = yield* step(() => paths.load(true));
    expect(config.currentProfileSet).toEqual({
      scope: "global",
      name: "missing",
      invalid: true,
    });
    expect(config.profileSources.generalist).toBe("global-invalid");
    expect(config.diagnostics).toContain("global.defaultProfileSet");
  });

  effectTest("fails closed on invalid JSON", function* () {
    const paths = yield* step(fixture);
    yield* step(() => writeFile(paths.globalPath, "{ not json"));
    yield* step(() =>
      expect(paths.load(true)).rejects.toMatchObject({
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
    const inspection = yield* step(() => paths.inspect(true));
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "global",
          profileSet: "default",
          profile: "scout",
          route: {
            host: "local",
            runtime: "pi",
            model: "openai-codex/gpt-5.6-sol",
            effort: "low",
            context: "fresh",
            writeIntent: "read-only",
            openaiFastMode: true,
            closeOnReport: true,
          },
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
          projectTrusted: true,
        }),
      ),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
    expect(saved).toMatchObject({ version: 6, defaultProfileSet: "default" });
    expect(saved.profileSets.default.profiles.reviewer).toEqual(initial.profiles.reviewer);
    expect(saved.profileSets.default.profiles.scout).toEqual({
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      context: "fresh",
      writeIntent: "read-only",
      openaiFastMode: true,
      closeOnReport: true,
    });
    const refreshed = yield* step(() => paths.inspect(true));
    expect(refreshed.config.profiles.scout.candidates[0]?.openaiFastMode).toBe(true);
  });

  effectTest("rejects unknown root fields and fails unknown profile aliases closed", function* () {
    const paths = yield* step(fixture);
    for (const document of [
      { version: 4, defaultProfile: "generalist" },
      { version: 4, customFutureField: true },
      { version: 4, nesting: { maxDirectChildren: 32, maxDepth: 8 } },
    ]) {
      yield* step(() => writeFile(paths.globalPath, JSON.stringify(document)));
      yield* step(() =>
        expect(paths.load(true)).rejects.toMatchObject({
          operation: "activate",
          path: paths.globalPath,
        }),
      );
    }
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({ version: 4, profiles: { delegate: "disabled" } }),
      ),
    );
    const config = yield* step(() => paths.load(true));
    expect(config.profileSources.generalist).toBe("builtin");
    expect(config.diagnostics).toContain("global.profiles.<unknown>");
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
    const inspection = yield* step(() => paths.inspect(true));
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "project",
            profileSet: "default",
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
          profileSet: "default",
          profile: "worker",
          expectedExists: true,
          expectedDocument: inspection.projectDocument,
          projectTrusted: true,
        }),
      ),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.projectPath, "utf8")));
    expect(saved.profileSets.default.profiles.worker).toBeUndefined();
    expect(saved.profileSets.default.profiles.reviewer).toBe("disabled");
  });

  effectTest("treats removal patches with no backing file or key as true no-ops", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      withStore((store) =>
        store.patchProfile(paths.cwd, paths.agentDirectory, {
          scope: "project",
          profileSet: "default",
          profile: "worker",
          expectedExists: false,
          projectTrusted: true,
        }),
      ),
    );
    yield* step(() =>
      withStore((store) =>
        store.patchNesting(paths.cwd, paths.agentDirectory, {
          scope: "project",
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
          profileSet: "default",
          profile: "worker",
          expectedExists: false,
          projectTrusted: true,
        }),
      ),
    );
    yield* step(() =>
      withStore((store) =>
        store.patchNesting(paths.cwd, paths.agentDirectory, {
          scope: "global",
          expectedExists: false,
          projectTrusted: true,
        }),
      ),
    );
    yield* step(() =>
      expect(readFile(paths.globalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" }),
    );
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 6,
          defaultProfileSet: "default",
          profileSets: { default: { profiles: { worker: "disabled" } } },
        }),
      ),
    );
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "default",
            profile: "worker",
            expectedExists: false,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
  });

  effectTest(
    "conflicts when an expected-missing document is externally created as an empty object",
    function* () {
      const paths = yield* step(fixture);
      yield* step(() => writeFile(paths.globalPath, "{}"));

      yield* step(() =>
        expect(
          withStore((store) =>
            store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, {
              scope: "global",
              profileSet: "new-set",
              profiles: BUILTIN_PROFILE_ROUTES,
              expectedExists: false,
              projectTrusted: true,
            }),
          ),
        ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
      );
      yield* step(() =>
        expect(
          withStore((store) =>
            store.patchProfile(paths.cwd, paths.agentDirectory, {
              scope: "global",
              profileSet: "default",
              profile: "worker",
              expectedExists: false,
              projectTrusted: true,
            }),
          ),
        ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
      );
      expect(JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")))).toEqual({});
    },
  );

  effectTest(
    "upgrades a v4 document on save even when its route patch is otherwise empty",
    function* () {
      const paths = yield* step(fixture);
      const raw = JSON.stringify({ version: 4 });
      yield* step(() => writeFile(paths.globalPath, raw));
      const inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "default",
            profile: "worker",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      expect(JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")))).toEqual({
        version: 6,
      });
    },
  );

  effectTest("applies strict v5 nesting precedence and rejects out-of-range values", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 5,
          nesting: { maxDirectChildren: 20, maxDepth: 6 },
        }),
      ),
    );
    yield* step(() =>
      writeFile(
        paths.projectPath,
        JSON.stringify({
          version: 5,
          nesting: { maxDirectChildren: 4, maxDepth: 2 },
        }),
      ),
    );
    const trusted = yield* step(() => paths.load(true));
    expect(trusted.nesting).toEqual({ maxDirectChildren: 4, maxDepth: 2 });
    expect(trusted.nestingSource).toBe("project");
    const untrusted = yield* step(() => paths.load(false));
    expect(untrusted.nesting).toEqual({ maxDirectChildren: 20, maxDepth: 6 });
    expect(untrusted.nestingSource).toBe("global");

    for (const nesting of [
      { maxDirectChildren: 0, maxDepth: 3 },
      { maxDirectChildren: 33, maxDepth: 3 },
      { maxDirectChildren: 12, maxDepth: -1 },
      { maxDirectChildren: 12, maxDepth: 9 },
      { maxDirectChildren: 12.5, maxDepth: 3 },
    ]) {
      yield* step(() => writeFile(paths.globalPath, JSON.stringify({ version: 5, nesting })));
      yield* step(() =>
        expect(paths.load(false)).rejects.toMatchObject({
          operation: "activate",
          path: paths.globalPath,
        }),
      );
    }
  });

  effectTest(
    "patches nesting and upgrades v4 documents through the single store door",
    function* () {
      const paths = yield* step(fixture);
      yield* step(() => writeFile(paths.globalPath, JSON.stringify({ version: 4 })));
      const inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        withStore((store) =>
          store.patchNesting(paths.cwd, paths.agentDirectory, {
            scope: "global",
            nesting: { maxDirectChildren: 7, maxDepth: 5 },
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      expect(JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")))).toEqual({
        version: 6,
        nesting: { maxDirectChildren: 7, maxDepth: 5 },
      });
    },
  );

  effectTest("migrates valid legacy routes and refuses malformed legacy data", function* () {
    const paths = yield* step(fixture);
    const legacy = {
      version: 5,
      profiles: {
        generalist: {
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "high",
          context: "fresh",
          writeIntent: "read-only",
          fastMode: true,
          closeOnReport: true,
        },
      },
      nesting: { maxDirectChildren: 10, maxDepth: 4 },
    };
    yield* step(() => writeFile(paths.globalPath, JSON.stringify(legacy)));
    let inspection = yield* step(() => paths.inspect(true));
    yield* step(() =>
      withStore((store) =>
        store.patchNesting(paths.cwd, paths.agentDirectory, {
          scope: "global",
          nesting: legacy.nesting,
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
          projectTrusted: true,
        }),
      ),
    );
    const migrated = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
    expect(migrated).toMatchObject({
      version: 6,
      defaultProfileSet: "default",
      nesting: legacy.nesting,
      profileSets: {
        default: {
          profiles: { generalist: { openaiFastMode: true } },
        },
      },
    });
    expect(JSON.stringify(migrated)).not.toContain("fastMode");

    for (const invalid of [
      { version: 4, profiles: [] },
      {
        version: 4,
        profiles: {
          scout: {
            host: "local",
            runtime: "pi",
            model: "bare",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
          },
        },
      },
    ]) {
      yield* step(() => writeFile(paths.globalPath, JSON.stringify(invalid)));
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        expect(
          withStore((store) =>
            store.patchProfile(paths.cwd, paths.agentDirectory, {
              scope: "global",
              profileSet: "default",
              profile: "worker",
              route: "disabled",
              expectedExists: true,
              expectedDocument: inspection.globalDocument,
              projectTrusted: true,
            }),
          ),
        ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
      );
      expect(JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")))).toEqual(invalid);
    }
  });

  effectTest("keeps structurally invalid sets repairable but refuses to select them", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 6,
          profileSets: {
            broken: { profiles: {}, extra: true },
            valid: { profiles: {} },
          },
        }),
      ),
    );
    let inspection = yield* step(() => paths.inspect(true));
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchDefaultProfileSet(paths.cwd, paths.agentDirectory, {
            scope: "global",
            defaultProfileSet: "broken",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
    yield* step(() =>
      withStore((store) =>
        store.deleteProfileSet(paths.cwd, paths.agentDirectory, {
          scope: "global",
          profileSet: "broken",
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
          projectTrusted: true,
        }),
      ),
    );
    inspection = yield* step(() => paths.inspect(true));
    expect(inspection.global.invalidProfileSets).toEqual([]);
    expect(inspection.global.file.profileSets).toHaveProperty("valid");
  });

  effectTest("refuses to select a set containing an invalid profile route", function* () {
    const paths = yield* step(fixture);
    const document = {
      version: 6,
      profileSets: {
        broken: { profiles: { worker: null } },
        valid: { profiles: {} },
      },
    };
    yield* step(() => writeFile(paths.globalPath, JSON.stringify(document)));
    const inspection = yield* step(() => paths.inspect(true));
    expect(inspection.global.invalidProfileSetRoutes.broken).toEqual(["worker"]);

    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchDefaultProfileSet(paths.cwd, paths.agentDirectory, {
            scope: "global",
            defaultProfileSet: "broken",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({
        operation: "update",
        path: paths.globalPath,
        message: expect.stringContaining("invalid profile route"),
      }),
    );
    expect(JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")))).toEqual(document);
  });

  effectTest(
    "creates, copies, renames, selects, and safely deletes scope-local sets",
    function* () {
      const paths = yield* step(fixture);
      yield* step(() =>
        withStore((store) =>
          store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "alpha",
            profiles: BUILTIN_PROFILE_ROUTES,
            expectedExists: false,
            projectTrusted: true,
          }),
        ),
      );
      let inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "alpha",
            profile: "generalist",
            route: {
              host: "local",
              runtime: "pi",
              model: "openai-codex/gpt-5.6-sol",
              effort: "high",
              context: "fresh",
              writeIntent: "read-only",
              openaiFastMode: true,
            },
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        withStore((store) =>
          store.copyProfileSet(paths.cwd, paths.agentDirectory, {
            scope: "global",
            sourceProfileSet: "alpha",
            profileSet: "copy",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        withStore((store) =>
          store.patchDefaultProfileSet(paths.cwd, paths.agentDirectory, {
            scope: "global",
            defaultProfileSet: "alpha",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        withStore((store) =>
          store.renameProfileSet(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "alpha",
            nextProfileSet: "main",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        expect(
          withStore((store) =>
            store.deleteProfileSet(paths.cwd, paths.agentDirectory, {
              scope: "global",
              profileSet: "main",
              expectedExists: true,
              expectedDocument: inspection.globalDocument,
              projectTrusted: true,
            }),
          ),
        ).rejects.toMatchObject({ operation: "update" }),
      );
      yield* step(() =>
        withStore((store) =>
          store.deleteProfileSet(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "copy",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      );
      const saved = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
      expect(saved.defaultProfileSet).toBe("main");
      expect(saved.profileSets.alpha).toBeUndefined();
      expect(saved.profileSets.copy).toBeUndefined();
      expect(saved.profileSets.main.profiles.generalist).toMatchObject({
        openaiFastMode: true,
      });
      expect(JSON.stringify(saved)).not.toContain("fastMode");
    },
  );

  effectTest("atomically saves all seven session routes as a non-default set", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      writeFile(
        paths.globalPath,
        JSON.stringify({
          version: 6,
          defaultProfileSet: "active",
          profileSets: { active: { profiles: {} } },
        }),
      ),
    );
    const inspection = yield* step(() => paths.inspect(true));
    const profiles = {
      ...inspection.config.profiles,
      reviewer: {
        candidates: [
          {
            host: "local" as const,
            runtime: "pi" as const,
            model: "openai/snapshot-reviewer",
            effort: "high" as const,
            context: "fresh" as const,
            writeIntent: "read-only" as const,
            closeOnReport: true,
          },
        ],
      },
      worker: { candidates: [] },
    };
    yield* step(() =>
      withStore((store) =>
        store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, {
          scope: "global",
          profileSet: "session-copy",
          profiles,
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
          projectTrusted: true,
        }),
      ),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
    expect(saved.defaultProfileSet).toBe("active");
    expect(Object.keys(saved.profileSets["session-copy"].profiles).sort()).toEqual(
      ["scout", "researcher", "planner", "worker", "reviewer", "oracle", "generalist"].sort(),
    );
    expect(saved.profileSets["session-copy"].profiles.worker).toBe("disabled");
    expect(saved.profileSets["session-copy"].profiles.reviewer[0].model).toBe(
      "openai/snapshot-reviewer",
    );

    yield* step(() =>
      expect(
        withStore((store) =>
          store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "stale-copy",
            profiles,
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
    const afterConflict = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
    expect(afterConflict.profileSets["stale-copy"]).toBeUndefined();
    expect(afterConflict.profileSets["session-copy"]).toEqual(saved.profileSets["session-copy"]);
  });

  effectTest(
    "rejects snapshot candidate accessors and custom iterators without invoking them",
    function* () {
      const paths = yield* step(fixture);
      const inspection = yield* step(() => paths.inspect(true));
      let accessorReads = 0;
      let iteratorCalls = 0;
      const routeWithCandidatesAccessor = Object.defineProperty({}, "candidates", {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error("candidates accessor must not run");
        },
      });
      const candidatesWithElementAccessor: unknown[] = [];
      Object.defineProperty(candidatesWithElementAccessor, "0", {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error("candidate accessor must not run");
        },
      });
      const candidatesWithCustomIterator = [inspection.config.profiles.reviewer.candidates[0]];
      Object.defineProperty(candidatesWithCustomIterator, Symbol.iterator, {
        value: () => {
          iteratorCalls += 1;
          throw new Error("custom iterator must not run");
        },
      });
      const candidateWithModelAccessor = {
        ...inspection.config.profiles.reviewer.candidates[0]!,
      };
      Object.defineProperty(candidateWithModelAccessor, "model", {
        enumerable: true,
        get() {
          accessorReads += 1;
          return "openai/getter-must-not-decode";
        },
      });
      const attempt = <ReviewerInput>(profileSet: string, reviewer: ReviewerInput) => {
        // SAFETY: This test deliberately violates the typed route contract to exercise hostile input containment.
        const profiles = { ...inspection.config.profiles, reviewer } as never;
        return withStore((store) =>
          store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet,
            profiles,
            expectedExists: false,
            projectTrusted: true,
          }),
        );
      };

      for (const [profileSet, reviewer] of [
        ["route-accessor", routeWithCandidatesAccessor],
        ["element-accessor", { candidates: candidatesWithElementAccessor }],
        ["candidate-accessor", { candidates: [candidateWithModelAccessor] }],
        ["custom-iterator", { candidates: candidatesWithCustomIterator }],
      ] as const) {
        yield* step(() =>
          expect(attempt(profileSet, reviewer)).rejects.toMatchObject({
            operation: "update",
            path: paths.globalPath,
          }),
        );
      }
      expect(accessorReads).toBe(0);
      expect(iteratorCalls).toBe(0);
      yield* step(() => expect(readFile(paths.globalPath, "utf8")).rejects.toBeDefined());
    },
  );

  effectTest("requires fresh Project trust for full-snapshot creation", function* () {
    const paths = yield* step(fixture);
    const inspection = yield* step(() => paths.inspect(false));
    const patch = {
      scope: "project" as const,
      profileSet: "session-copy",
      profiles: inspection.config.profiles,
      expectedExists: false,
      projectTrusted: false,
    };
    yield* step(() =>
      expect(
        withStore((store) =>
          store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, patch),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.projectPath }),
    );
    yield* step(() => expect(readFile(paths.projectPath, "utf8")).rejects.toBeDefined());

    yield* step(() =>
      withStore((store) =>
        store.createProfileSetFromSnapshot(paths.cwd, paths.agentDirectory, {
          ...patch,
          projectTrusted: true,
        }),
      ),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.projectPath, "utf8")));
    expect(saved.defaultProfileSet).toBeUndefined();
    expect(Object.keys(saved.profileSets["session-copy"].profiles)).toHaveLength(7);
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
    const inspection = yield* step(() => paths.inspect(true));
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
            profileSet: "default",
            profile: "worker",
            route: "disabled",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchNesting(paths.cwd, paths.agentDirectory, {
            scope: "global",
            nesting: { maxDirectChildren: 8, maxDepth: 4 },
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
    yield* step(() =>
      expect(
        withStore((store) =>
          store.patchProfile(paths.cwd, paths.agentDirectory, {
            scope: "global",
            profileSet: "default",
            profile: "worker",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
            projectTrusted: true,
          }),
        ),
      ).rejects.toMatchObject({ operation: "update", path: paths.globalPath }),
    );
    const saved = JSON.parse(yield* step(() => readFile(paths.globalPath, "utf8")));
    expect(saved.profiles.scout.effort).toBe("high");
    expect(saved.nesting).toBeUndefined();
  });
});
