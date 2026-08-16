// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "pi-cosmic-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterXai from "../src/extension.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Handler = ExtensionHandler<any, any>;
type Completion = { value: string; label: string; description?: string };
type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
type SettingsComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
};

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-xai-settings-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-better-xai-agent-"));
  tempDirectories.push(cwd, agentDir);
  const configDirectory = join(cwd, ".pi", "extensions");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "pi-better-xai.json"),
    '{"usage":{"enabled":false},"footer":{"mode":"status"}}\n',
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const notify = vi.fn();
  const custom = vi.fn();
  const pi = extensionApiFixture({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    events: { emit: vi.fn(), on: vi.fn() },
  });
  const ctx = extensionContextFixture({
    cwd,
    mode: "tui",
    hasUI: true,
    model: { provider: "xai", id: "grok" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
    ui: { notify, custom, setStatus: vi.fn(), setFooter: vi.fn() },
    isProjectTrusted: vi.fn(() => true),
  });

  betterXai(pi);
  return { handlers, commands, ctx, cwd, notify, custom };
}

const completionValues = async (
  result: Completion[] | Promise<Completion[] | null> | null | undefined,
): Promise<string[] | null> => {
  const completions = await result;
  return completions ? completions.map((completion) => completion.value) : null;
};

// SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
const readConfig = (cwd: string): { usage?: { showResetTimes?: boolean } } =>
  JSON.parse(readFileSync(join(cwd, ".pi", "extensions", "pi-better-xai.json"), "utf8")) as {
    usage?: { showResetTimes?: boolean };
  };

describe("Better xAI settings surface", () => {
  test("completes setting ids, help/diagnostics, and finite values", async () => {
    const h = harness();
    const complete = h.commands.get("xai-settings")?.getArgumentCompletions;
    expect(complete).toBeTypeOf("function");

    expect(await completionValues(complete?.(""))).toEqual([
      "usage.enabled",
      "usage.refreshIntervalMs",
      "usage.showOnlyOnSubscriptionModels",
      "usage.showResetTimes",
      "footer.mode",
      "help",
      "diagnostics",
    ]);
    expect(await completionValues(complete?.("usage.s"))).toEqual([
      "usage.showOnlyOnSubscriptionModels",
      "usage.showResetTimes",
    ]);
    expect(await completionValues(complete?.("FOOTER"))).toEqual(["footer.mode"]);
    expect(await completionValues(complete?.("footer.mode "))).toEqual([
      "footer.mode replace",
      "footer.mode status",
      "footer.mode off",
    ]);
    expect(await completionValues(complete?.("footer.mode re"))).toEqual(["footer.mode replace"]);
    expect(await completionValues(complete?.("usage.enabled t"))).toEqual(["usage.enabled true"]);
    expect(complete?.("zzz")).toBeNull();
    expect(complete?.("unknown ")).toBeNull();
    expect(complete?.("help ")).toBeNull();
  });

  test("rejects the removed debug alias; diagnostics is the only diagnostics verb", async () => {
    const h = harness();

    await h.commands.get("xai-settings")?.handler("debug", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Usage: /xai-settings <id> <value>", "error");

    await h.commands.get("xai-settings")?.handler("debug now", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Unknown setting: debug", "error");
  });

  test("opens a modeless interactive settings list for bare /xai-settings in TUI mode", async () => {
    const h = harness();
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    const done = vi.fn();
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = factory(
        { requestRender: vi.fn() },
        { fg: (_tone: string, text: string) => text, bold: (text: string) => text },
        {},
        done,
      ) as SettingsComponent;
      return Promise.resolve(undefined);
    });

    await h.handlers.get("session_start")?.({}, h.ctx);
    await h.commands.get("xai-settings")?.handler("", h.ctx);

    expect(h.custom).toHaveBeenCalledTimes(1);
    const page = stripAnsi(component!.render(100).join("\n"));
    expect(page).toContain("Better xAI Settings");
    expect(page).toContain("Usage display");
    expect(page).toContain("Footer mode");
    expect(page).toContain("? help");
    expect(page).not.toMatch(/NORMAL|INSERT|SEARCH/);
    expect(page).toMatch(/Usage reset times\s+true/);

    // j moves the selection and Enter cycles the finite value, persisting it immediately.
    for (let index = 0; index < 3; index++) component!.handleInput("j");
    component!.handleInput("\r");
    await vi.waitFor(() => {
      expect(readConfig(h.cwd).usage?.showResetTimes).toBe(false);
    });
    expect(stripAnsi(component!.render(100).join("\n"))).toMatch(/Usage reset times\s+false/);

    component!.handleInput("q");
    expect(done).toHaveBeenCalledWith(undefined);

    await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
  });

  test("rolls back the optimistic list value when a typed apply failure occurs", async () => {
    const h = harness();
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = factory(
        { requestRender: vi.fn() },
        { fg: (_tone: string, text: string) => text, bold: (text: string) => text },
        {},
        vi.fn(),
      ) as SettingsComponent;
      return Promise.resolve(undefined);
    });
    await h.handlers.get("session_start")?.({}, h.ctx);
    await h.commands.get("xai-settings")?.handler("", h.ctx);

    // Break persistence after startup: the config path becomes an unwritable directory, so the
    // apply fails with the typed config error while the in-memory projection keeps "true".
    const configPath = join(h.cwd, ".pi", "extensions", "pi-better-xai.json");
    rmSync(configPath);
    mkdirSync(configPath);

    const enter = String.fromCharCode(13);
    const flatPage = () => stripAnsi(component!.render(100).join(" ")).replace(/ +/g, " ");
    for (let index = 0; index < 3; index++) component!.handleInput("j");
    expect(flatPage()).toContain("Usage reset times true");
    component!.handleInput(enter);
    // SettingsList displays the cycled value optimistically before the apply settles.
    expect(flatPage()).toContain("Usage reset times false");
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(expect.any(String), "error");
    });
    expect(flatPage()).toContain("Usage reset times true");

    await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
  });

  test("rolls back the optimistic list value when the apply cannot run", async () => {
    const h = harness();
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = factory(
        { requestRender: vi.fn() },
        { fg: (_tone: string, text: string) => text, bold: (text: string) => text },
        {},
        vi.fn(),
      ) as SettingsComponent;
      return Promise.resolve(undefined);
    });
    await h.handlers.get("session_start")?.({}, h.ctx);
    // An already-aborted host signal makes the captured runtime execution fail, exercising the
    // Promise-level recovery path while the persisted projection stays intact.
    const abort = new AbortController();
    abort.abort();
    Object.assign(h.ctx, { signal: abort.signal });
    await h.commands.get("xai-settings")?.handler("", h.ctx);

    const enter = String.fromCharCode(13);
    const flatPage = () => stripAnsi(component!.render(100).join(" ")).replace(/ +/g, " ");
    for (let index = 0; index < 3; index++) component!.handleInput("j");
    component!.handleInput(enter);
    expect(flatPage()).toContain("Usage reset times false");
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith("Better xAI settings are unavailable.", "warning");
    });
    expect(flatPage()).toContain("Usage reset times true");
    expect(readConfig(h.cwd).usage?.showResetTimes).toBeUndefined();

    await h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
  });

  test("falls back to scriptable help for the bare command without interactive TUI", async () => {
    const h = harness();
    Object.assign(h.ctx, { mode: "rpc" });

    await h.commands.get("xai-settings")?.handler("", h.ctx);

    expect(h.custom).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Better xAI settings"), "info");
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("/xai-settings <id> <value>"),
      "info",
    );

    h.notify.mockClear();
    Object.assign(h.ctx, { mode: "tui" });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    delete (h.ctx as { ui: { custom?: unknown } }).ui.custom;
    await h.commands.get("xai-settings")?.handler("", h.ctx);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Better xAI settings"), "info");
  });
});
