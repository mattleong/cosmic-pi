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
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { declaredCandidate, profileCandidate } from "./fixtures/profiles.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = nodeFsPromises;
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

/** A store mutation patch whose Project trust defaults to granted. */
type Trusted<Method extends keyof SubagentConfigStoreContract> = Omit<
  Parameters<SubagentConfigStoreContract[Method]>[2],
  "projectTrusted"
> & { readonly projectTrusted?: boolean };
const trusted = <Patch extends { readonly projectTrusted?: boolean }>(patch: Patch) => ({
  projectTrusted: true,
  ...patch,
});

const rejects = <A>(attempt: () => Promise<A>, operation: string, path: string) =>
  step(() => expect(attempt()).rejects.toMatchObject({ operation, path }));

const fixture = () =>
  mkdtemp(join(tmpdir(), "pi-subagents-config-")).then((root) => {
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    const globalPath = join(agentDirectory, "pi-subagents.json");
    const projectPath = join(cwd, CONFIG_DIR_NAME, "pi-subagents.json");
    return mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true })
      .then(() => mkdir(agentDirectory, { recursive: true }))
      .then(() => ({
        globalPath,
        projectPath,
        writeGlobal: <Document>(document: Document) =>
          writeFile(globalPath, JSON.stringify(document)),
        writeProject: <Document>(document: Document) =>
          writeFile(projectPath, JSON.stringify(document)),
        readGlobal: () => readFile(globalPath, "utf8").then(JSON.parse),
        readProject: () => readFile(projectPath, "utf8").then(JSON.parse),
        load: (trust: boolean) => withStore((store) => store.load(cwd, agentDirectory, trust)),
        inspect: (trust: boolean) =>
          withStore((store) => store.inspect(cwd, agentDirectory, trust)),
        patchProfile: (patch: Trusted<"patchProfile">) =>
          withStore((store) => store.patchProfile(cwd, agentDirectory, trusted(patch))),
        patchNesting: (patch: Trusted<"patchNesting">) =>
          withStore((store) => store.patchNesting(cwd, agentDirectory, trusted(patch))),
        patchDefaultProfileSet: (patch: Trusted<"patchDefaultProfileSet">) =>
          withStore((store) => store.patchDefaultProfileSet(cwd, agentDirectory, trusted(patch))),
        createProfileSetFromSnapshot: (patch: Trusted<"createProfileSetFromSnapshot">) =>
          withStore((store) =>
            store.createProfileSetFromSnapshot(cwd, agentDirectory, trusted(patch)),
          ),
        copyProfileSet: (patch: Trusted<"copyProfileSet">) =>
          withStore((store) => store.copyProfileSet(cwd, agentDirectory, trusted(patch))),
        renameProfileSet: (patch: Trusted<"renameProfileSet">) =>
          withStore((store) => store.renameProfileSet(cwd, agentDirectory, trusted(patch))),
        deleteProfileSet: (patch: Trusted<"deleteProfileSet">) =>
          withStore((store) => store.deleteProfileSet(cwd, agentDirectory, trusted(patch))),
        patchWriterWorkspace: (patch: Trusted<"patchWriterWorkspace">) =>
          withStore((store) => store.patchWriterWorkspace(cwd, agentDirectory, trusted(patch))),
      }));
  });

describe("SubagentConfigStore v6", () => {
  effectTest(
    "fails mixed retired routes closed in every version and scope without load writes",
    function* () {
      const paths = yield* step(fixture);
      const local = declaredCandidate("openai/local");
      for (const version of [4, 5, 6])
        for (const scope of ["global", "project"] as const)
          for (const runtime of ["pi", "claude", "codex"])
            for (const remoteFirst of [true, false]) {
              const remote = declaredCandidate(runtime === "pi" ? "openai/remote" : "native", {
                host: "herdr",
                runtime,
              });
              const profiles = {
                worker: remoteFirst ? [remote, local] : [local, remote],
                scout: local,
              };
              const raw =
                version === 6
                  ? {
                      version,
                      defaultProfileSet: "default",
                      profileSets: { default: { profiles } },
                    }
                  : { version, profiles };
              yield* step(() =>
                paths.writeGlobal({
                  version: 6,
                  defaultProfileSet: "default",
                  profileSets: { default: { profiles: { worker: local } } },
                }),
              );
              if (scope === "global") yield* step(() => paths.writeGlobal(raw));
              else yield* step(() => paths.writeProject(raw));
              const target = scope === "global" ? paths.globalPath : paths.projectPath;
              const before = yield* step(() => readFile(target, "utf8"));
              const beforeStat = yield* step(() => stat(target));
              const config = yield* step(() => paths.load(scope === "project"));
              expect(config.profiles.worker.candidates).toEqual([]);
              expect(config.profileSources.worker).toBe(`${scope}-invalid`);
              expect(config.profiles.scout.candidates[0]?.model).toBe("openai/local");
              expect(config.profileSources.scout).toBe(scope);
              expect(yield* step(() => readFile(target, "utf8"))).toBe(before);
              const afterStat = yield* step(() => stat(target));
              expect([afterStat.ino, afterStat.mtimeMs]).toEqual([
                beforeStat.ino,
                beforeStat.mtimeMs,
              ]);
            }
    },
  );

  effectTest("persists typed local patches with undefined optional fields", function* () {
    for (const asArray of [false, true]) {
      const paths = yield* step(fixture);
      const document = {
        version: 6,
        defaultProfileSet: "default",
        profileSets: { default: { profiles: {} } },
      };
      yield* step(() => paths.writeGlobal(document));
      const candidate = {
        ...profileCandidate("openai/local"),
        openaiFastMode: undefined,
        closeOnReport: undefined,
      };
      yield* step(() =>
        paths.patchProfile({
          scope: "global",
          profileSet: "default",
          profile: "worker",
          route: asArray ? [candidate] : candidate,
          expectedExists: true,
          expectedDocument: document,
        }),
      );
      const persisted = yield* step(paths.readGlobal);
      const route = persisted.profileSets.default.profiles.worker;
      expect(Array.isArray(route)).toBe(asArray);
      const written = asArray ? route[0] : route;
      expect(Object.hasOwn(written, "openaiFastMode")).toBe(false);
      expect(Object.hasOwn(written, "closeOnReport")).toBe(false);
      const loaded = yield* step(() => paths.load(false));
      expect(loaded.profileSources.worker).toBe("global");
      expect(loaded.profiles.worker.candidates[0]).toMatchObject({
        host: "local",
        model: "openai/local",
        closeOnReport: true,
      });
    }
  });

  effectTest(
    "rejects direct invalid typed patches without changing the raw document",
    function* () {
      const paths = yield* step(fixture);
      const local = declaredCandidate("openai/local");
      const document = {
        version: 6,
        defaultProfileSet: "default",
        profileSets: { default: { profiles: { worker: local } } },
      };
      yield* step(() => paths.writeGlobal(document));
      let reads = 0;
      const accessor = { ...local };
      Object.defineProperty(accessor, "host", {
        enumerable: true,
        get: () => {
          reads += 1;
          return "herdr";
        },
      });
      const accessorArray = [local];
      Object.defineProperty(accessorArray, "0", {
        enumerable: true,
        get: () => {
          reads += 1;
          return local;
        },
      });
      const invalidRoutes = [
        { ...local, host: "herdr" },
        { ...local, closeOnReport: false },
        { ...local, model: undefined },
        { ...local, unknown: undefined },
        [local, { ...local, host: "herdr" }],
        accessor,
        accessorArray,
      ];
      const before = yield* step(() => readFile(paths.globalPath, "utf8"));
      for (const route of invalidRoutes) {
        // SAFETY: The public typed store boundary is intentionally supplied unknown invalid input.
        yield* rejects(
          () =>
            paths.patchProfile({
              scope: "global",
              profileSet: "default",
              profile: "worker",
              route: route as never,
              expectedExists: true,
              expectedDocument: document,
            }),
          "update",
          paths.globalPath,
        );
        expect(yield* step(() => readFile(paths.globalPath, "utf8"))).toBe(before);
      }
      expect(reads).toBe(0);
    },
  );

  effectTest(
    "repairs only the targeted v6 declaration and rejects selecting the still-invalid set",
    function* () {
      const paths = yield* step(fixture);
      const remote = declaredCandidate("openai/remote", { host: "herdr" });
      const invalid = { not: "a candidate" };
      const initial = {
        version: 6,
        profileSets: {
          repair: {
            profiles: {
              worker: remote,
              reviewer: [remote, declaredCandidate("openai/local")],
              scout: invalid,
            },
          },
          other: { profiles: { planner: remote } },
        },
      };
      yield* step(() => paths.writeGlobal(initial));
      yield* rejects(
        () =>
          paths.patchDefaultProfileSet({
            scope: "global",
            defaultProfileSet: "repair",
            expectedExists: true,
            expectedDocument: initial,
          }),
        "update",
        paths.globalPath,
      );
      const local = profileCandidate("openai/repaired");
      yield* step(() =>
        paths.patchProfile({
          scope: "global",
          profileSet: "repair",
          profile: "worker",
          route: local,
          expectedExists: true,
          expectedDocument: initial,
        }),
      );
      const { openaiFastMode: _fast, ...persistedLocal } = local;
      const expected = {
        ...initial,
        profileSets: {
          ...initial.profileSets,
          repair: { profiles: { ...initial.profileSets.repair.profiles, worker: persistedLocal } },
        },
      };
      expect(yield* step(paths.readGlobal)).toEqual(expected);
      yield* rejects(
        () =>
          paths.patchDefaultProfileSet({
            scope: "global",
            defaultProfileSet: "repair",
            expectedExists: true,
            expectedDocument: expected,
          }),
        "update",
        paths.globalPath,
      );
      expect(yield* step(paths.readGlobal)).toEqual(expected);
    },
  );

  effectTest("never migrates legacy remote routes until an explicit complete repair", function* () {
    const paths = yield* step(fixture);
    for (const version of [4, 5]) {
      const remote = declaredCandidate("openai/remote", { host: "herdr" });
      const initial = { version, profiles: { worker: remote, reviewer: remote } };
      yield* step(() => paths.writeGlobal(initial));
      yield* rejects(
        () =>
          paths.patchNesting({
            scope: "global",
            nesting: { maxDirectChildren: 4, maxDepth: 2 },
            expectedExists: true,
            expectedDocument: initial,
          }),
        "update",
        paths.globalPath,
      );
      yield* rejects(
        () =>
          paths.patchProfile({
            scope: "global",
            profileSet: "default",
            profile: "worker",
            route: "disabled",
            expectedExists: true,
            expectedDocument: initial,
          }),
        "update",
        paths.globalPath,
      );
      expect(yield* step(paths.readGlobal)).toEqual(initial);
      const repairable = { version, profiles: { worker: remote } };
      yield* step(() => paths.writeGlobal(repairable));
      yield* step(() =>
        paths.patchProfile({
          scope: "global",
          profileSet: "default",
          profile: "worker",
          route: "disabled",
          expectedExists: true,
          expectedDocument: repairable,
        }),
      );
      expect(yield* step(paths.readGlobal)).toMatchObject({
        version: 6,
        profileSets: { default: { profiles: { worker: "disabled" } } },
      });
    }
  });

  effectTest("loads v4 routes with v6 nesting defaults and project inheritance", function* () {
    const paths = yield* step(fixture);
    const worker = declaredCandidate("openai/worker", { writeIntent: "writer" });
    yield* step(() => paths.writeGlobal({ version: 4, profiles: { worker } }));
    yield* step(() => paths.writeProject({ version: 4 }));
    const config = yield* step(() => paths.load(true));
    expect(config.profiles.worker).toEqual({ candidates: [worker] });
    expect(config.profileSources.worker).toBe("global");
    expect(config.fallbackProfile).toBe("generalist");
    expect(config.nesting).toEqual({ maxDirectChildren: 12, maxDepth: 3 });
  });

  effectTest("rejects unsupported or malformed global documents at activation", function* () {
    const paths = yield* step(fixture);
    for (const document of [
      { version: 1 },
      { version: 2 },
      {},
      { version: "4" },
      { version: 4, defaultProfile: "generalist" },
      { version: 4, customFutureField: true },
      { version: 4, nesting: { maxDirectChildren: 32, maxDepth: 8 } },
      { version: 5, nesting: { maxDirectChildren: 0, maxDepth: 3 } },
      { version: 5, nesting: { maxDirectChildren: 33, maxDepth: 3 } },
      { version: 5, nesting: { maxDirectChildren: 12, maxDepth: -1 } },
      { version: 5, nesting: { maxDirectChildren: 12, maxDepth: 9 } },
      { version: 5, nesting: { maxDirectChildren: 12.5, maxDepth: 3 } },
      { version: 6, writerWorkspaceMode: "invalid" },
    ]) {
      yield* step(() => paths.writeGlobal(document));
      yield* rejects(() => paths.load(true), "activate", paths.globalPath);
    }
  });

  effectTest("accepts v4/v5 documents and never reads an untrusted project", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      paths.writeGlobal({ version: 3, denied: [{ backend: "pi", model: "legacy" }] }),
    );
    yield* step(() =>
      expect(paths.load(true)).rejects.toMatchObject({
        operation: "activate",
        message: expect.stringContaining("must declare version 4"),
      }),
    );
    yield* step(() => paths.writeGlobal({ version: 4 }));
    yield* step(() => writeFile(paths.projectPath, "{ not json"));
    yield* step(() => paths.load(false));
  });

  effectTest("keeps invalid defaults loadable for fail-closed settings repair", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      paths.writeGlobal({
        version: 6,
        defaultProfileSet: "missing",
        profileSets: { valid: { profiles: {} } },
      }),
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
    yield* rejects(() => paths.load(true), "read", paths.globalPath);
  });

  effectTest("atomically patches one profile while preserving unrelated routes", function* () {
    const paths = yield* step(fixture);
    const initial = {
      version: 4,
      profiles: {
        scout: declaredCandidate("parent", { effort: "default" }),
        reviewer: [
          declaredCandidate("openai/first", { effort: "medium" }),
          declaredCandidate("openai/second"),
        ],
      },
    };
    yield* step(() => paths.writeGlobal(initial));
    const inspection = yield* step(() => paths.inspect(true));
    const scout = profileCandidate("openai-codex/gpt-5.6-sol", {
      effort: "low",
      openaiFastMode: true,
    });
    yield* step(() =>
      paths.patchProfile({
        scope: "global",
        profileSet: "default",
        profile: "scout",
        route: scout,
        expectedExists: true,
        expectedDocument: inspection.globalDocument,
      }),
    );
    const saved = yield* step(paths.readGlobal);
    expect(saved).toMatchObject({ version: 6, defaultProfileSet: "default" });
    expect(saved.profileSets.default.profiles.reviewer).toEqual(initial.profiles.reviewer);
    expect(saved.profileSets.default.profiles.scout).toEqual(scout);
    const refreshed = yield* step(() => paths.inspect(true));
    expect(refreshed.config.profiles.scout.candidates[0]?.openaiFastMode).toBe(true);
  });

  effectTest("fails unknown profile aliases closed", function* () {
    const paths = yield* step(fixture);
    yield* step(() => paths.writeGlobal({ version: 4, profiles: { delegate: "disabled" } }));
    const config = yield* step(() => paths.load(true));
    expect(config.profileSources.generalist).toBe("builtin");
    expect(config.diagnostics).toContain("global.profiles.<unknown>");
  });

  effectTest("removes inherited routes and rejects untrusted project writes", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      paths.writeProject({
        version: 4,
        profiles: {
          worker: declaredCandidate("parent", { effort: "default" }),
          reviewer: "disabled",
        },
      }),
    );
    const inspection = yield* step(() => paths.inspect(true));
    const removal: Trusted<"patchProfile"> = {
      scope: "project",
      profileSet: "default",
      profile: "worker",
      expectedExists: true,
      expectedDocument: inspection.projectDocument,
    };
    yield* rejects(
      () => paths.patchProfile({ ...removal, projectTrusted: false }),
      "update",
      paths.projectPath,
    );
    yield* step(() => paths.patchProfile(removal));
    const saved = yield* step(paths.readProject);
    expect(saved.profileSets.default.profiles.worker).toBeUndefined();
    expect(saved.profileSets.default.profiles.reviewer).toBe("disabled");
  });

  effectTest("treats removal patches with no backing file or key as true no-ops", function* () {
    const paths = yield* step(fixture);
    const removeWorker = (scope: "global" | "project") =>
      paths.patchProfile({
        scope,
        profileSet: "default",
        profile: "worker",
        expectedExists: false,
      });
    for (const [scope, path] of [
      ["project", paths.projectPath],
      ["global", paths.globalPath],
    ] as const) {
      yield* step(() => removeWorker(scope));
      yield* step(() => paths.patchNesting({ scope, expectedExists: false }));
      yield* step(() => expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" }));
    }
    yield* step(() =>
      paths.writeGlobal({
        version: 6,
        defaultProfileSet: "default",
        profileSets: { default: { profiles: { worker: "disabled" } } },
      }),
    );
    yield* rejects(() => removeWorker("global"), "update", paths.globalPath);
  });

  effectTest(
    "conflicts when an expected-missing document is externally created as an empty object",
    function* () {
      const paths = yield* step(fixture);
      yield* step(() => writeFile(paths.globalPath, "{}"));

      yield* rejects(
        () =>
          paths.createProfileSetFromSnapshot({
            scope: "global",
            profileSet: "new-set",
            profiles: BUILTIN_PROFILE_ROUTES,
            expectedExists: false,
          }),
        "update",
        paths.globalPath,
      );
      yield* rejects(
        () =>
          paths.patchProfile({
            scope: "global",
            profileSet: "default",
            profile: "worker",
            expectedExists: false,
          }),
        "update",
        paths.globalPath,
      );
      expect(yield* step(paths.readGlobal)).toEqual({});
    },
  );

  effectTest(
    "upgrades a v4 document on save even when its route patch is otherwise empty",
    function* () {
      const paths = yield* step(fixture);
      yield* step(() => paths.writeGlobal({ version: 4 }));
      const inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        paths.patchProfile({
          scope: "global",
          profileSet: "default",
          profile: "worker",
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
        }),
      );
      expect(yield* step(paths.readGlobal)).toEqual({ version: 6 });
    },
  );

  effectTest("applies strict v5 nesting precedence", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      paths.writeGlobal({ version: 5, nesting: { maxDirectChildren: 20, maxDepth: 6 } }),
    );
    yield* step(() =>
      paths.writeProject({ version: 5, nesting: { maxDirectChildren: 4, maxDepth: 2 } }),
    );
    const trusted = yield* step(() => paths.load(true));
    expect(trusted.nesting).toEqual({ maxDirectChildren: 4, maxDepth: 2 });
    const untrusted = yield* step(() => paths.load(false));
    expect(untrusted.nesting).toEqual({ maxDirectChildren: 20, maxDepth: 6 });
  });

  effectTest("migrates valid legacy routes and refuses malformed legacy data", function* () {
    const paths = yield* step(fixture);
    const legacy = {
      version: 5,
      profiles: { generalist: declaredCandidate("openai-codex/gpt-5.6-sol", { fastMode: true }) },
      nesting: { maxDirectChildren: 10, maxDepth: 4 },
    };
    yield* step(() => paths.writeGlobal(legacy));
    let inspection = yield* step(() => paths.inspect(true));
    yield* step(() =>
      paths.patchNesting({
        scope: "global",
        nesting: legacy.nesting,
        expectedExists: true,
        expectedDocument: inspection.globalDocument,
      }),
    );
    const migrated = yield* step(paths.readGlobal);
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
      { version: 4, profiles: { scout: declaredCandidate("bare") } },
    ]) {
      yield* step(() => paths.writeGlobal(invalid));
      inspection = yield* step(() => paths.inspect(true));
      yield* rejects(
        () =>
          paths.patchProfile({
            scope: "global",
            profileSet: "default",
            profile: "worker",
            route: "disabled",
            expectedExists: true,
            expectedDocument: inspection.globalDocument,
          }),
        "update",
        paths.globalPath,
      );
      expect(yield* step(paths.readGlobal)).toEqual(invalid);
    }
  });

  effectTest("keeps structurally invalid sets repairable but refuses to select them", function* () {
    const paths = yield* step(fixture);
    yield* step(() =>
      paths.writeGlobal({
        version: 6,
        profileSets: {
          broken: { profiles: {}, extra: true },
          valid: { profiles: {} },
        },
      }),
    );
    let inspection = yield* step(() => paths.inspect(true));
    const current = {
      scope: "global",
      expectedExists: true,
      expectedDocument: inspection.globalDocument,
    } as const;
    yield* rejects(
      () => paths.patchDefaultProfileSet({ ...current, defaultProfileSet: "broken" }),
      "update",
      paths.globalPath,
    );
    yield* step(() => paths.deleteProfileSet({ ...current, profileSet: "broken" }));
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
    yield* step(() => paths.writeGlobal(document));
    const inspection = yield* step(() => paths.inspect(true));
    expect(inspection.global.invalidProfileSetRoutes.broken).toEqual(["worker"]);

    yield* step(() =>
      expect(
        paths.patchDefaultProfileSet({
          scope: "global",
          defaultProfileSet: "broken",
          expectedExists: true,
          expectedDocument: inspection.globalDocument,
        }),
      ).rejects.toMatchObject({
        operation: "update",
        path: paths.globalPath,
        message: expect.stringContaining("invalid profile route"),
      }),
    );
    expect(yield* step(paths.readGlobal)).toEqual(document);
  });

  effectTest(
    "creates, copies, renames, selects, and safely deletes scope-local sets",
    function* () {
      const paths = yield* step(fixture);
      yield* step(() =>
        paths.createProfileSetFromSnapshot({
          scope: "global",
          profileSet: "alpha",
          profiles: BUILTIN_PROFILE_ROUTES,
          expectedExists: false,
        }),
      );
      let inspection = yield* step(() => paths.inspect(true));
      // Every later write is guarded by the most recent inspection.
      const current = () => ({
        scope: "global" as const,
        expectedExists: true,
        expectedDocument: inspection.globalDocument,
      });
      yield* step(() =>
        paths.patchProfile({
          ...current(),
          profileSet: "alpha",
          profile: "generalist",
          route: profileCandidate("openai-codex/gpt-5.6-sol", { openaiFastMode: true }),
        }),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        paths.copyProfileSet({ ...current(), sourceProfileSet: "alpha", profileSet: "copy" }),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() => paths.patchDefaultProfileSet({ ...current(), defaultProfileSet: "alpha" }));
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        paths.renameProfileSet({ ...current(), profileSet: "alpha", nextProfileSet: "main" }),
      );
      inspection = yield* step(() => paths.inspect(true));
      yield* step(() =>
        expect(paths.deleteProfileSet({ ...current(), profileSet: "main" })).rejects.toMatchObject({
          operation: "update",
        }),
      );
      yield* step(() => paths.deleteProfileSet({ ...current(), profileSet: "copy" }));
      const saved = yield* step(paths.readGlobal);
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
      paths.writeGlobal({
        version: 6,
        defaultProfileSet: "active",
        profileSets: { active: { profiles: {} } },
      }),
    );
    const inspection = yield* step(() => paths.inspect(true));
    const saveSnapshot = (profileSet: string) =>
      paths.createProfileSetFromSnapshot({
        scope: "global",
        profileSet,
        profiles: {
          ...inspection.config.profiles,
          reviewer: { candidates: [profileCandidate("openai/snapshot-reviewer")] },
          worker: { candidates: [] },
        },
        expectedExists: true,
        expectedDocument: inspection.globalDocument,
      });
    yield* step(() => saveSnapshot("session-copy"));
    const saved = yield* step(paths.readGlobal);
    expect(saved.defaultProfileSet).toBe("active");
    expect(Object.keys(saved.profileSets["session-copy"].profiles).sort()).toEqual(
      [...PROFILE_IDS].sort(),
    );
    expect(saved.profileSets["session-copy"].profiles.worker).toBe("disabled");
    expect(saved.profileSets["session-copy"].profiles.reviewer[0].model).toBe(
      "openai/snapshot-reviewer",
    );

    yield* rejects(() => saveSnapshot("stale-copy"), "update", paths.globalPath);
    const afterConflict = yield* step(paths.readGlobal);
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
        return paths.createProfileSetFromSnapshot({
          scope: "global",
          profileSet,
          profiles,
          expectedExists: false,
        });
      };

      for (const [profileSet, reviewer] of [
        ["route-accessor", routeWithCandidatesAccessor],
        ["element-accessor", { candidates: candidatesWithElementAccessor }],
        ["candidate-accessor", { candidates: [candidateWithModelAccessor] }],
        ["custom-iterator", { candidates: candidatesWithCustomIterator }],
      ] as const) {
        yield* rejects(() => attempt(profileSet, reviewer), "update", paths.globalPath);
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
    };
    yield* rejects(
      () => paths.createProfileSetFromSnapshot({ ...patch, projectTrusted: false }),
      "update",
      paths.projectPath,
    );
    yield* step(() => expect(readFile(paths.projectPath, "utf8")).rejects.toBeDefined());

    yield* step(() => paths.createProfileSetFromSnapshot(patch));
    const saved = yield* step(paths.readProject);
    expect(saved.defaultProfileSet).toBeUndefined();
    expect(Object.keys(saved.profileSets["session-copy"].profiles)).toHaveLength(7);
  });

  effectTest("detects external edits instead of clobbering them", function* () {
    const paths = yield* step(fixture);
    const scoutDocument = (effort: string) => ({
      version: 4,
      profiles: { scout: declaredCandidate("parent", { effort }) },
    });
    yield* step(() => paths.writeGlobal(scoutDocument("low")));
    const inspection = yield* step(() => paths.inspect(true));
    yield* step(() => paths.writeGlobal(scoutDocument("high")));
    const stale = {
      scope: "global",
      expectedExists: true,
      expectedDocument: inspection.globalDocument,
    } as const;
    for (const write of [
      () =>
        paths.patchProfile({
          ...stale,
          profileSet: "default",
          profile: "worker",
          route: "disabled",
        }),
      () => paths.patchNesting({ ...stale, nesting: { maxDirectChildren: 8, maxDepth: 4 } }),
      () => paths.patchProfile({ ...stale, profileSet: "default", profile: "worker" }),
    ]) {
      yield* rejects<object | void>(write, "update", paths.globalPath);
    }
    const saved = yield* step(paths.readGlobal);
    expect(saved.profiles.scout.effort).toBe("high");
    expect(saved.nesting).toBeUndefined();
  });
});

describe("writer workspace preference persistence", () => {
  effectTest(
    "saves and clears a preference without changing profile sets or nesting",
    function* () {
      const paths = yield* step(fixture);
      const original = {
        version: 6,
        profileSets: { saved: { profiles: {} } },
        defaultProfileSet: "saved",
        nesting: { maxDirectChildren: 4, maxDepth: 2 },
      };
      yield* step(() => paths.writeGlobal(original));
      yield* step(() =>
        paths.patchWriterWorkspace({
          scope: "global",
          expectedExists: true,
          expectedDocument: original,
          writerWorkspaceMode: "shared-checkout",
        }),
      );
      const saved = { ...original, writerWorkspaceMode: "shared-checkout" };
      expect(yield* step(paths.readGlobal)).toEqual(saved);
      expect((yield* step(() => paths.load(false))).writerWorkspaceMode).toBe("shared-checkout");
      yield* step(() =>
        paths.patchWriterWorkspace({
          scope: "global",
          expectedExists: true,
          expectedDocument: saved,
        }),
      );
      expect(yield* step(paths.readGlobal)).toEqual(original);
      expect((yield* step(() => paths.load(false))).writerWorkspaceMode).toBe("shared-checkout");
    },
  );

  effectTest("rejects stale preference saves without overwriting another edit", function* () {
    const paths = yield* step(fixture);
    const current = { version: 6, writerWorkspaceMode: "worktree" };
    yield* step(() => paths.writeGlobal(current));
    yield* rejects(
      () =>
        paths.patchWriterWorkspace({
          scope: "global",
          expectedExists: true,
          expectedDocument: { version: 6 },
          writerWorkspaceMode: "shared-checkout",
        }),
      "update",
      paths.globalPath,
    );
    expect(yield* step(paths.readGlobal)).toEqual(current);
  });

  effectTest("migrates valid legacy documents when saving a workspace preference", function* () {
    const paths = yield* step(fixture);
    const original = { version: 5, nesting: { maxDirectChildren: 4, maxDepth: 2 } };
    yield* step(() => paths.writeGlobal(original));
    yield* step(() =>
      paths.patchWriterWorkspace({
        scope: "global",
        expectedExists: true,
        expectedDocument: original,
        writerWorkspaceMode: "shared-checkout",
      }),
    );
    expect(yield* step(paths.readGlobal)).toEqual({
      ...original,
      version: 6,
      writerWorkspaceMode: "shared-checkout",
    });
  });
});
