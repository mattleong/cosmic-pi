// Node filesystem setup is a test boundary for the live JSON-document Layer.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrConfigStore } from "../src/config/store.ts";
import type { PersistedHerdrProject } from "../src/config/schema.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
  roots.push(root);
  const agentDirectory = join(root, "agent");
  const cwd = join(root, "repo");
  await mkdir(join(agentDirectory, "extensions"), { recursive: true });
  await mkdir(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
  return { root, agentDirectory, cwd };
};

const runStore = <A, E>(
  cwd: string,
  agentDirectory: string,
  projectTrusted: boolean,
  effect: Effect.Effect<A, E, HerdrConfigStore>,
) => {
  const platform = Layer.merge(nodeFilePlatformLayer, AgentDirectory.layer(agentDirectory));
  const layer = HerdrConfigStore.layer({ cwd, projectTrusted }).pipe(Layer.provide(platform));
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
};

const persistedRun = (id: string, updatedAt: number) => ({
  id,
  name: id,
  agentName: `pih-${id}`,
  task: "Review",
  cwd: "/repo",
  state: "working" as const,
  workspaceId: "w1",
  tabId: "w1:t2",
  paneId: `pane-${id}`,
  terminalId: `term-${id}`,
  reportGeneration: id,
  startedAt: updatedAt,
  updatedAt,
});

const projectState = (cwd: string): PersistedHerdrProject => ({
  key: `default\u0000${cwd}`,
  session: "default",
  cwd,
  workspaceId: "w1",
  workspaceOwned: false,
  tabId: "w1:t2",
  tabLabel: "pi-herdr · Claude",
  anchorPaneId: "w1:p2",
  runs: [],
});

describe("HerdrConfigStore", () => {
  it("merges trusted project configuration and ignores untrusted project files", async () => {
    const paths = await fixture();
    await writeFile(
      join(paths.agentDirectory, "extensions", "pi-herdr.json"),
      JSON.stringify({ version: 1, pollIntervalMs: 700, showFooterStatus: false }),
    );
    await writeFile(
      join(paths.cwd, CONFIG_DIR_NAME, "extensions", "pi-herdr.json"),
      JSON.stringify({ version: 1, pollIntervalMs: 300, session: "project" }),
    );
    const trusted = await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.map(HerdrConfigStore, (store) => store.config),
    );
    expect(trusted).toMatchObject({
      pollIntervalMs: 300,
      session: "project",
      showFooterStatus: false,
    });
    const untrusted = await runStore(
      paths.cwd,
      paths.agentDirectory,
      false,
      Effect.map(HerdrConfigStore, (store) => store.config),
    );
    expect(untrusted.session).toBeUndefined();
    expect(untrusted.pollIntervalMs).toBe(700);
  });

  it("atomically saves and reloads private ownership state", async () => {
    const paths = await fixture();
    const state = {
      ...projectState(paths.cwd),
      runs: [
        {
          ...persistedRun("herdr-round-trip", 1),
          remoteStatus: "working" as const,
        },
      ],
    };
    await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) => store.saveProject(state)),
    );
    const loaded = await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) => store.loadProject(state.key)),
    );
    expect(loaded).toEqual(state);
  });

  it("merges runs from concurrent session snapshots and supports explicit eviction", async () => {
    const paths = await fixture();
    const state = projectState(paths.cwd);
    const runA = persistedRun("herdr-a", 1);
    const runB = persistedRun("herdr-b", 2);
    await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.gen(function* () {
        const store = yield* HerdrConfigStore;
        yield* store.saveProject({ ...state, runs: [runA] });
        yield* store.saveProject({ ...state, runs: [runB] });
      }),
    );
    const merged = await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) => store.loadProject(state.key)),
    );
    expect(merged?.runs.map((run) => run.id).sort()).toEqual(["herdr-a", "herdr-b"]);

    await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) =>
        store.saveProject({ ...state, runs: [runB] }, { removeRunIds: [runA.id] }),
      ),
    );
    const evicted = await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) => store.loadProject(state.key)),
    );
    expect(evicted?.runs.map((run) => run.id)).toEqual(["herdr-b"]);
  });

  it("preserves terminal states when concurrent snapshots contain active states", async () => {
    const paths = await fixture();
    const state = projectState(paths.cwd);
    const id = "herdr-terminal";
    const active = persistedRun(id, 20);
    const completed = {
      ...persistedRun(id, 10),
      state: "completed" as const,
      report: "done",
      completedAt: 10,
    };
    await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.gen(function* () {
        const store = yield* HerdrConfigStore;
        yield* store.saveProject({ ...state, runs: [active] });
        yield* store.saveProject({ ...state, runs: [completed] });
        yield* store.saveProject({ ...state, runs: [{ ...active, updatedAt: 30 }] });
      }),
    );

    const loaded = await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) => store.loadProject(state.key)),
    );
    expect(loaded?.runs).toEqual([completed]);

    const stopped = {
      ...persistedRun(id, 5),
      state: "stopped" as const,
      completedAt: 5,
    };
    await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.gen(function* () {
        const store = yield* HerdrConfigStore;
        yield* store.saveProject({ ...state, runs: [stopped] });
        yield* store.saveProject({ ...state, runs: [{ ...completed, updatedAt: 40 }] });
      }),
    );
    const stoppedLoaded = await runStore(
      paths.cwd,
      paths.agentDirectory,
      true,
      Effect.flatMap(HerdrConfigStore, (store) => store.loadProject(state.key)),
    );
    expect(stoppedLoaded?.runs).toEqual([stopped]);
  });

  it("fails closed on unsupported config versions", async () => {
    const paths = await fixture();
    await writeFile(
      join(paths.agentDirectory, "extensions", "pi-herdr.json"),
      JSON.stringify({ version: 2 }),
    );
    await expect(
      runStore(
        paths.cwd,
        paths.agentDirectory,
        true,
        Effect.map(HerdrConfigStore, (store) => store.config),
      ),
    ).rejects.toMatchObject({ operation: "decode" });
  });
});
