// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterXai from "../src/extension.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => unknown;

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-xai-project-"));
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
  const commands = new Map<string, Command>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const setFooter = vi.fn();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: Command }) {
      commands.set(name, options.handler);
    },
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    model: { provider: "xai", id: "grok" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
    ui: { notify, setStatus, setFooter },
  } as unknown as ExtensionContext;

  betterXai(pi);
  return { handlers, commands, ctx, notify, setStatus, setFooter };
}

async function invoke(value: unknown) {
  await value;
}

describe("Better xAI Effect boundary", () => {
  test("serializes repeated starts, serves commands, and disposes idempotently", async () => {
    const h = harness();
    await invoke(h.handlers.get("session_start")?.({}, h.ctx));
    await invoke(h.handlers.get("session_start")?.({}, h.ctx));

    expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(h.setFooter).not.toHaveBeenCalled();
    await invoke(h.commands.get("xai-usage")?.("", h.ctx));
    expect(h.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");

    await invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    await invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
  });
});
