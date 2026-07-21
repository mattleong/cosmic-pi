import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { DEFAULT_CONFIG, type ResolvedCosmicUiConfig } from "../src/config/schema.ts";
import { createFooterComponent } from "../src/footer/component.ts";
import { emptyFooterRegistrySnapshot } from "../src/footer/registry.ts";

const config: ResolvedCosmicUiConfig = {
  configPath: "/config.json",
  projectConfigPath: "/project/.pi/cosmic-ui.json",
  globalConfigPath: "/global/cosmic-ui.json",
  footer: DEFAULT_CONFIG.footer,
};

describe("footer component host boundary", () => {
  test("contains hostile live getters and retains only bounded host-query diagnostics", () => {
    const hostile = <A>(): A => {
      throw new Error("host payload must not escape");
    };
    const getLeafId = vi.fn(() => hostile<string>());
    const getCwd = vi.fn(() => hostile<string>());
    const getSessionName = vi.fn(() => hostile<string>());
    const contextWindow = vi.fn(() => hostile<number>());
    const getContextUsage = vi.fn(() =>
      Object.defineProperties(
        {},
        {
          tokens: { get: () => 10 },
          contextWindow: { get: contextWindow },
          percent: { get: () => 10 },
        },
      ),
    );
    const isUsingOAuth = vi.fn(() => hostile<boolean>());
    const getThinkingLevel = vi.fn(() => hostile<"off">());
    const getGitBranch = vi.fn(() => hostile<string>());
    const getAvailableProviderCount = vi.fn(() => hostile<number>());
    const getExtensionStatuses = vi.fn(() => ({
      entries: () => hostile<IterableIterator<[string, string]>>(),
    }));
    const ctx = {
      model: {
        id: "model",
        provider: "provider",
        reasoning: true,
        contextWindow: 100_000,
      },
      modelRegistry: { isUsingOAuth },
      getContextUsage,
      sessionManager: { getLeafId, getCwd, getSessionName },
    } as unknown as ExtensionContext;
    const pi = { getThinkingLevel } as unknown as ExtensionAPI;
    const footerData = {
      getGitBranch,
      getAvailableProviderCount,
      getExtensionStatuses,
    } as unknown as ReadonlyFooterDataProvider;
    const callbacks = makeHostCallbackBoundary(4);
    const component = createFooterComponent({
      pi,
      ctx: () => ctx,
      footerData,
      theme: { fg: (_color, text) => text },
      registry: {
        snapshot: emptyFooterRegistrySnapshot,
        invalidate: vi.fn(),
      },
      callbacks,
      config: () => config,
      totals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
      gitStatus: () => undefined,
      pullRequestNumber: () => undefined,
      homeDirectory: () => undefined,
    });

    expect(() => component.render(80)).not.toThrow();
    expect(getLeafId).toHaveBeenCalledOnce();
    expect(getContextUsage).toHaveBeenCalledOnce();
    expect(contextWindow).toHaveBeenCalledOnce();
    expect(getCwd).toHaveBeenCalledOnce();
    expect(getSessionName).toHaveBeenCalledOnce();
    expect(isUsingOAuth).toHaveBeenCalledOnce();
    expect(getThinkingLevel).toHaveBeenCalledOnce();
    expect(getGitBranch).toHaveBeenCalledOnce();
    expect(getAvailableProviderCount).toHaveBeenCalledOnce();
    expect(getExtensionStatuses).toHaveBeenCalledOnce();
    expect(callbacks.diagnostics()).toHaveLength(4);
    expect(callbacks.diagnostics()).toEqual([
      { operation: "host-query" },
      { operation: "host-query" },
      { operation: "host-query" },
      { operation: "host-query" },
    ]);
  });

  test("returns a stable empty render when a hostile theme callback throws", () => {
    const callbacks = makeHostCallbackBoundary();
    const component = createFooterComponent({
      pi: { getThinkingLevel: () => "off" } as unknown as ExtensionAPI,
      ctx: () =>
        ({
          model: undefined,
          modelRegistry: { isUsingOAuth: () => false },
          getContextUsage: () => undefined,
          sessionManager: {
            getLeafId: () => "leaf",
            getCwd: () => "/project",
            getSessionName: () => undefined,
          },
        }) as unknown as ExtensionContext,
      footerData: {
        getGitBranch: () => null,
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => new Map(),
      } as unknown as ReadonlyFooterDataProvider,
      theme: {
        fg: () => {
          throw new Error("theme failure");
        },
      },
      registry: {
        snapshot: emptyFooterRegistrySnapshot,
        invalidate: vi.fn(),
      },
      callbacks,
      config: () => config,
      totals: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
      gitStatus: () => undefined,
      pullRequestNumber: () => undefined,
      homeDirectory: () => undefined,
    });

    expect(component.render(80)).toEqual([]);
    expect(callbacks.diagnostics()).toEqual([{ operation: "footer-render" }]);
  });
});
