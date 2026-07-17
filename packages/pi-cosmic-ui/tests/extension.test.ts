import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import cosmicUi from "../index.ts";
import {
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_PROTOCOL_VERSION,
} from "../src/protocol.ts";

type Handler = (event: any, ctx: ExtensionContext) => void | Promise<void>;

function harness(mode: "tui" | "rpc" = "tui") {
  const handlers = new Map<string, Handler[]>();
  const bus = new Map<string, Set<(data: unknown) => void>>();
  const setFooter = vi.fn();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: vi.fn(),
    getThinkingLevel: vi.fn(() => "high"),
    exec: vi.fn(async () => ({
      stdout: "## main...origin/main\n M changed.ts\n?? new.ts\n",
      stderr: "",
      code: 0,
      killed: false,
    })),
    events: {
      emit(name: string, data: unknown) {
        for (const handler of bus.get(name) ?? []) handler(data);
      },
      on(name: string, handler: (data: unknown) => void) {
        const entries = bus.get(name) ?? new Set();
        entries.add(handler);
        bus.set(name, entries);
        return () => entries.delete(handler);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    mode,
    hasUI: true,
    model: { id: "model-long-name", provider: "provider", reasoning: true, contextWindow: 100_000 },
    modelRegistry: { isUsingOAuth: vi.fn(() => false) },
    getContextUsage: vi.fn(() => ({ contextWindow: 100_000, tokens: 12_500, percent: 12.5 })),
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => "/tmp/project"),
      getSessionName: vi.fn(() => "session"),
      getLeafId: vi.fn(() => "leaf"),
    },
    ui: { setFooter, notify: vi.fn(), custom: vi.fn() },
  } as unknown as ExtensionContext;
  cosmicUi(pi);
  return { pi, ctx, handlers, setFooter };
}

async function emit(h: ReturnType<typeof harness>, name: string, event: any = {}) {
  for (const handler of h.handlers.get(name) ?? []) await handler(event, h.ctx);
}

describe("Cosmic UI extension", () => {
  test("answers host queries and installs an ANSI-safe responsive footer in TUI mode", async () => {
    const h = harness();
    let found = false;
    h.pi.events.emit(COSMIC_UI_HOST_QUERY, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      respond: () => {
        found = true;
      },
    });
    expect(found).toBe(true);
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "malformed",
      contribution: { kind: "surface", id: "broken", region: "media", preferredWidth: 4 },
    });
    h.pi.events.emit(COSMIC_UI_FOOTER_UPSERT, {
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "pi-better-openai",
      contribution: {
        kind: "text",
        id: "openai.usage",
        region: "details",
        text: "Usage: 5h: 90% | 7d: 51%",
      },
    });
    await emit(h, "session_start");
    expect(h.setFooter).toHaveBeenCalledOnce();
    const factory = h.setFooter.mock.calls[0]?.[0];
    const footer = factory(
      { requestRender: vi.fn() },
      { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[0m` },
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 2,
        onBranchChange: () => vi.fn(),
      },
    );
    for (const width of [32, 64, 100])
      expect(footer.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
    const rendered = footer.render(100).join("\n");
    expect(rendered).toContain("Context");
    expect(rendered).toContain("OpenAI");
    expect(rendered).toContain("main");
    expect(rendered).toContain("~1 ?1");
    expect(rendered.indexOf("model-long-name")).toBeLessThan(rendered.indexOf("high"));
    expect(rendered.indexOf("high")).toBeLessThan(rendered.indexOf("/tmp/project"));
    expect(h.ctx.getContextUsage).toHaveBeenCalledTimes(1);
    await emit(h, "message_update");
    footer.render(100);
    expect(h.ctx.getContextUsage).toHaveBeenCalledTimes(2);
  });

  test("reinstalls the footer when session_start supplies a new context", async () => {
    const h = harness();
    await emit(h, "session_start");
    const secondContext = {
      ...h.ctx,
      model: { ...h.ctx.model!, id: "second-model" },
      sessionManager: {
        ...h.ctx.sessionManager,
        getEntries: vi.fn(() => []),
        getCwd: vi.fn(() => "/tmp/second-project"),
        getSessionName: vi.fn(() => "second-session"),
        getLeafId: vi.fn(() => "second-leaf"),
      },
    } as ExtensionContext;
    for (const handler of h.handlers.get("session_start") ?? []) await handler({}, secondContext);

    expect(h.setFooter).toHaveBeenNthCalledWith(2, undefined);
    expect(h.setFooter).toHaveBeenCalledTimes(3);
    const factory = h.setFooter.mock.calls[2]?.[0];
    const footer = factory(
      { requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text },
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => vi.fn(),
      },
    );
    expect(footer.render(100).join("\n")).toContain("second-model • high • /tmp/second-project");
    expect(footer.render(100).join("\n")).toContain("second-session");
  });

  test("does not install terminal footer UI in RPC mode", async () => {
    const h = harness("rpc");
    await emit(h, "session_start");
    expect(h.setFooter).not.toHaveBeenCalled();
  });
});
