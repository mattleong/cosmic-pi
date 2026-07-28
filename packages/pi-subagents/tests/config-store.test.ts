// Node filesystem setup is a test boundary for the live JSON-document Layer.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentConfigStore, subagentConfigStoreLayer } from "../src/config/store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const load = (cwd: string, agentDirectory: string, projectTrusted: boolean) =>
  Effect.runPromise(
    Effect.flatMap(SubagentConfigStore, (store) =>
      store.load(cwd, agentDirectory, projectTrusted),
    ).pipe(Effect.provide(subagentConfigStoreLayer.pipe(Layer.provide(nodeFilePlatformLayer)))),
  );

describe("SubagentConfigStore", () => {
  it("loads the documented global and trusted project paths with safe merge semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, "pi-subagents.json"),
      JSON.stringify({
        defaultProfile: "planner",
        denied: [{ backend: "pi", model: "openai/global-denied" }],
      }),
    );
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
      JSON.stringify({
        defaultProfile: "reviewer",
        denied: [{ backend: "claude-cli", model: "haiku" }],
      }),
    );

    const config = await load(cwd, agentDirectory, true);
    expect(config).toMatchObject({
      globalConfigPath: join(agentDirectory, "pi-subagents.json"),
      projectConfigPath: join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
      defaultProfile: "reviewer",
      globalConfigExists: true,
      projectConfigExists: true,
    });
    expect(config.denied).toEqual([
      { backend: "pi", model: "openai/global-denied" },
      { backend: "claude-cli", model: "haiku" },
    ]);
  });

  it("fails closed when the global policy document is not valid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(join(agentDirectory, "pi-subagents.json"), "{ not json");

    await expect(load(cwd, agentDirectory, true)).rejects.toMatchObject({
      _tag: "SubagentConfigStoreError",
      operation: "read",
      path: join(agentDirectory, "pi-subagents.json"),
    });
  });

  it("fails closed when the trusted project policy document is not valid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, "pi-subagents.json"),
      JSON.stringify({ defaultProfile: "planner" }),
    );
    await writeFile(join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"), "{ not json");

    await expect(load(cwd, agentDirectory, true)).rejects.toMatchObject({
      _tag: "SubagentConfigStoreError",
      operation: "read",
      path: join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
    });
  });

  it("fails activation closed on an unsupported declared configuration version", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, "pi-subagents.json"),
      JSON.stringify({ version: 2, defaultProfile: "planner" }),
    );

    const failure = await load(cwd, agentDirectory, true).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      _tag: "SubagentConfigStoreError",
      operation: "activate",
      path: join(agentDirectory, "pi-subagents.json"),
    });
    // Diagnostics stay path-safe: the declared version value is never echoed back.
    expect(String((failure as { message: string }).message)).not.toContain("2");

    await writeFile(
      join(agentDirectory, "pi-subagents.json"),
      JSON.stringify({ version: 1, defaultProfile: "planner" }),
    );
    await writeFile(
      join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
      JSON.stringify({ version: 3, defaultProfile: "reviewer" }),
    );
    await expect(load(cwd, agentDirectory, true)).rejects.toMatchObject({
      _tag: "SubagentConfigStoreError",
      operation: "activate",
      path: join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"),
    });

    // The untrusted project document is never read, so its version cannot fail activation.
    const untrusted = await load(cwd, agentDirectory, false);
    expect(untrusted.defaultProfile).toBe("planner");
    expect(untrusted.projectConfigExists).toBe(false);
  });

  it("does not inspect an untrusted project document", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
    roots.push(root);
    const agentDirectory = join(root, "agent");
    const cwd = join(root, "repo");
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      join(agentDirectory, "pi-subagents.json"),
      JSON.stringify({ defaultProfile: "planner" }),
    );
    // This would fail JSON-document decoding if the untrusted path were read.
    await writeFile(join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"), "{ not json");

    const config = await load(cwd, agentDirectory, false);
    expect(config.defaultProfile).toBe("planner");
    expect(config.projectConfigExists).toBe(false);
  });
});
