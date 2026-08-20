// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  registerDirectoryModelsWithDependencies,
  type DirectoryModelsApplicationDependencies,
} from "../src/application.ts";
import { preferenceFilename } from "../src/boundary/path-key.ts";
import type { DirectoryModelPreference } from "../src/config/schema.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Handler = ExtensionHandler<any, any>;
type Model = NonNullable<ExtensionContext["model"]>;

function model(provider: string, id: string): Model {
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  return { provider, id, reasoning: true } as Model;
}

function preferencePath(agentDirectory: string, cwd: string): string {
  const canonical = realpathSync(cwd);
  return join(
    agentDirectory,
    "pi-directory-models",
    preferenceFilename(canonical, basename(canonical)),
  );
}

function readPreference(agentDirectory: string, cwd: string): DirectoryModelPreference {
  // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
  return JSON.parse(
    readFileSync(preferencePath(agentDirectory, cwd), "utf8"),
  ) as DirectoryModelPreference;
}

function writePreference(
  agentDirectory: string,
  cwd: string,
  preference: Omit<DirectoryModelPreference, "cwd" | "version">,
): void {
  const path = preferencePath(agentDirectory, cwd);
  mkdirSync(join(agentDirectory, "pi-directory-models"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, cwd: realpathSync(cwd), ...preference }, null, 2)}\n`,
  );
}

function harness(
  options: {
    readonly explicitModel?: boolean;
    readonly entries?: readonly { readonly type: string }[];
    readonly cwd?: string;
    readonly delayThinkingEvents?: boolean;
    readonly setModelSettlement?: Promise<void>;
  } = {},
) {
  const realCwd = mkdtempSync(join(tmpdir(), "pi-directory-models-project-"));
  const agentDirectory = mkdtempSync(join(tmpdir(), "pi-directory-models-agent-"));
  temporaryDirectories.push(realCwd, agentDirectory);
  const cwd = options.cwd ?? realCwd;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;

  const initial = model("anthropic", "claude-sonnet");
  const remembered = model("openai-codex", "gpt-5.6-sol");
  const alternate = model("xai", "grok-code");
  const available = new Map(
    [initial, remembered, alternate].map((value) => [`${value.provider}/${value.id}`, value]),
  );
  let activeModel = initial;
  let thinkingLevel: "low" | "medium" | "high" = "low";
  const handlers = new Map<string, Handler>();
  const notify = vi.fn();
  let ctx!: ExtensionContext;
  const delayedThinkingEvents: unknown[] = [];
  const setModel = vi.fn(async (next: Model) => {
    await options.setModelSettlement;
    const previousModel = activeModel;
    activeModel = next;
    await handlers.get("model_select")?.(
      { type: "model_select", model: next, previousModel, source: "set" },
      ctx,
    );
    return true;
  });
  const setThinkingLevel = vi.fn((level: typeof thinkingLevel) => {
    const previousLevel = thinkingLevel;
    thinkingLevel = level;
    const event = { type: "thinking_level_select", level, previousLevel };
    if (options.delayThinkingEvents) delayedThinkingEvents.push(event);
    else void handlers.get("thinking_level_select")?.(event, ctx);
  });
  const piFixture = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    setModel,
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel,
  };
  // SAFETY: Tests invoke only the ExtensionAPI members implemented by this fixture.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const contextFixture = {
    cwd,
    get model() {
      return activeModel;
    },
    modelRegistry: {
      find(provider: string, id: string) {
        return available.get(`${provider}/${id}`);
      },
    },
    sessionManager: {
      buildContextEntries: () => [...(options.entries ?? [])],
    },
    ui: { notify },
  };
  // SAFETY: Tests invoke only the ExtensionContext members implemented by this fixture.
  ctx = contextFixture as typeof contextFixture & ExtensionContext;
  const dependencies: DirectoryModelsApplicationDependencies = {
    hasExplicitModel: () => options.explicitModel ?? false,
  };
  registerDirectoryModelsWithDependencies(pi, dependencies);

  const emit = async <Event>(name: string, event: Event) => {
    await handlers.get(name)?.(event, ctx);
  };
  const start = (reason: "startup" | "new" | "resume" | "fork" | "reload" = "startup") =>
    emit("session_start", { type: "session_start", reason });
  const shutdown = () => emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

  return {
    realCwd,
    cwd,
    agentDirectory,
    initial,
    remembered,
    alternate,
    available,
    notify,
    setModel,
    setThinkingLevel,
    start,
    shutdown,
    emit,
    select(next: Model, thinking: "low" | "medium" | "high" = thinkingLevel) {
      activeModel = next;
      thinkingLevel = thinking;
    },
    thinking: () => thinkingLevel,
    async flushThinkingEvents() {
      for (const event of delayedThinkingEvents.splice(0))
        await handlers.get("thinking_level_select")?.(event, ctx);
    },
  };
}

describe.sequential("directory models application", () => {
  test("initializes a readable preference for an ordinary fresh session", async () => {
    const h = harness();
    await h.start();

    expect(basename(preferencePath(h.agentDirectory, h.cwd))).toMatch(
      /^pi-directory-models-project-.*--[a-f0-9]{12}\.json$/,
    );
    expect(readPreference(h.agentDirectory, h.cwd)).toMatchObject({
      cwd: realpathSync(h.cwd),
      provider: h.initial.provider,
      model: h.initial.id,
      thinkingLevel: "low",
    });
    await h.shutdown();
  });

  test("restores model and thinking for fresh startup and /new", async () => {
    const h = harness();
    writePreference(h.agentDirectory, h.cwd, {
      provider: h.remembered.provider,
      model: h.remembered.id,
      thinkingLevel: "high",
    });

    await h.start();
    expect(h.setModel).toHaveBeenCalledWith(h.remembered);
    expect(h.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(h.thinking()).toBe("high");

    h.select(h.initial, "low");
    await h.start("new");
    expect(h.setModel).toHaveBeenLastCalledWith(h.remembered);
    expect(h.thinking()).toBe("high");
    await h.shutdown();
  });

  test("waits for a noncancelable model settlement before a successor session starts", async () => {
    const settlement = await Effect.runPromise(Deferred.make<void>());
    const h = harness({ setModelSettlement: Effect.runPromise(Deferred.await(settlement)) });
    writePreference(h.agentDirectory, h.cwd, {
      provider: h.remembered.provider,
      model: h.remembered.id,
      thinkingLevel: "high",
    });

    const first = h.start();
    await vi.waitFor(() => expect(h.setModel).toHaveBeenCalledTimes(1));
    let successorSettled = false;
    const successor = h.start("new").then(() => {
      successorSettled = true;
    });
    await Effect.runPromise(Effect.sleep("10 millis"));

    expect(successorSettled).toBe(false);
    expect(h.setModel).toHaveBeenCalledTimes(1);

    await Effect.runPromise(Deferred.succeed(settlement, undefined));
    await Promise.all([first, successor]);
    expect(h.setModel).toHaveBeenCalledTimes(1);
    expect(h.thinking()).toBe("high");
    expect(h.notify).not.toHaveBeenCalledWith(
      "Unable to save the directory model preference.",
      "warning",
    );
    await h.shutdown();
  });

  test("leaves explicit --model and resumed session choices alone", async () => {
    const explicit = harness({ explicitModel: true });
    await explicit.start();
    expect(existsSync(preferencePath(explicit.agentDirectory, explicit.cwd))).toBe(false);
    expect(explicit.setModel).not.toHaveBeenCalled();
    await explicit.start("new");
    expect(existsSync(preferencePath(explicit.agentDirectory, explicit.cwd))).toBe(false);
    await explicit.shutdown();

    for (const entry of [{ type: "message" }, { type: "custom_message" }]) {
      const resumed = harness({ entries: [entry] });
      await resumed.start();
      expect(existsSync(preferencePath(resumed.agentDirectory, resumed.cwd))).toBe(false);
      expect(resumed.setModel).not.toHaveBeenCalled();
      await resumed.shutdown();
    }
  });

  test("preserves resume, fork, and reload event models", async () => {
    for (const reason of ["resume", "fork", "reload"] as const) {
      const h = harness();
      writePreference(h.agentDirectory, h.cwd, {
        provider: h.remembered.provider,
        model: h.remembered.id,
        thinkingLevel: "high",
      });
      await h.start(reason);
      expect(h.setModel).not.toHaveBeenCalled();
      await h.shutdown();
    }
  });

  test("persists interactive model and thinking changes but ignores restore events", async () => {
    const h = harness();
    await h.start();

    h.select(h.remembered, "medium");
    await h.emit("model_select", {
      type: "model_select",
      model: h.remembered,
      previousModel: h.initial,
      source: "set",
    });
    expect(readPreference(h.agentDirectory, h.cwd)).toMatchObject({
      provider: h.remembered.provider,
      model: h.remembered.id,
      thinkingLevel: "medium",
    });

    h.select(h.remembered, "high");
    await h.emit("thinking_level_select", {
      type: "thinking_level_select",
      level: "high",
      previousLevel: "medium",
    });
    expect(readPreference(h.agentDirectory, h.cwd).thinkingLevel).toBe("high");

    h.select(h.alternate, "low");
    await h.emit("model_select", {
      type: "model_select",
      model: h.alternate,
      previousModel: h.remembered,
      source: "restore",
    });
    expect(readPreference(h.agentDirectory, h.cwd)).toMatchObject({
      provider: h.remembered.provider,
      model: h.remembered.id,
      thinkingLevel: "high",
    });
    await h.shutdown();
  });

  test("ignores malformed thinking-level events", async () => {
    const h = harness();
    await h.start();
    h.select(h.remembered, "high");

    await h.emit("thinking_level_select", {
      type: "thinking_level_select",
      level: "unexpected-level",
      previousLevel: "low",
    });

    expect(readPreference(h.agentDirectory, h.cwd)).toMatchObject({
      provider: h.initial.provider,
      model: h.initial.id,
      thinkingLevel: "low",
    });
    await h.shutdown();
  });

  test("suppresses thinking events delayed past restoration", async () => {
    const h = harness({ delayThinkingEvents: true });
    writePreference(h.agentDirectory, h.cwd, {
      provider: h.remembered.provider,
      model: h.remembered.id,
      thinkingLevel: "high",
    });
    await h.start();

    h.select(h.alternate, "medium");
    await h.emit("model_select", {
      type: "model_select",
      model: h.alternate,
      previousModel: h.remembered,
      source: "set",
    });
    await h.flushThinkingEvents();

    expect(readPreference(h.agentDirectory, h.cwd)).toMatchObject({
      provider: h.alternate.provider,
      model: h.alternate.id,
      thinkingLevel: "medium",
    });
    await h.shutdown();
  });

  test("retains an unavailable preference and fails open with one warning", async () => {
    const h = harness();
    writePreference(h.agentDirectory, h.cwd, {
      provider: "missing-provider",
      model: "missing-model",
      thinkingLevel: "high",
    });

    await h.start();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(readPreference(h.agentDirectory, h.cwd)).toMatchObject({
      provider: "missing-provider",
      model: "missing-model",
    });
    expect(h.notify).toHaveBeenCalledWith(
      "The remembered directory model is not available.",
      "warning",
    );
    await h.shutdown();
  });

  test("canonicalizes symlink aliases to the target directory preference", async () => {
    const target = mkdtempSync(join(tmpdir(), "pi-directory-models-target-"));
    const parent = mkdtempSync(join(tmpdir(), "pi-directory-models-link-parent-"));
    const alias = join(parent, "cern-alias");
    symlinkSync(target, alias, "dir");
    temporaryDirectories.push(target, parent);
    const h = harness({ cwd: alias });

    await h.start();
    expect(readPreference(h.agentDirectory, target).cwd).toBe(realpathSync(target));
    expect(existsSync(preferencePath(h.agentDirectory, alias))).toBe(true);
    await h.shutdown();
  });
});
