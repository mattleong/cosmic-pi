import type { ExtensionContext, SourceInfo } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { JsonObject } from "pi-cosmic-core";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  betterOpenAIWithDependencies,
  type BetterOpenAIExtensionDependencies,
} from "../src/application.ts";

export const ownerSource: SourceInfo = {
  source: "local",
  path: "/extensions/pi-better-openai/index.ts",
  scope: "user",
  origin: "top-level",
};

// Pure fixture serialization stays outside Effect code on purpose: the runtime under
// test owns schema decoding of this persisted document.
const encodeConfigDocument = (overrides: JsonObject): string =>
  JSON.stringify({ persistState: false, usage: {}, image: { enabled: false }, ...overrides });

/**
 * The actual factory over a temporary trusted project. Public tool metadata names `toolSource`;
 * command metadata always names the extension itself.
 */
export const extensionHarness = (
  options: {
    readonly dependencies?: BetterOpenAIExtensionDependencies;
    readonly config?: JsonObject;
    readonly toolSource?: SourceInfo;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "openai-extension-" });
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "openai-agent-" });
    yield* fs.makeDirectory(path.join(cwd, ".pi", "extensions"), { recursive: true });
    yield* fs.writeFileString(
      path.join(cwd, ".pi", "extensions", "pi-better-openai.json"),
      encodeConfigDocument(options.config ?? {}),
    );
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDir));
    const host = recordingExtensionHost(
      { source: ownerSource, ...(options.toolSource && { toolSource: options.toolSource }) },
      {
        registerFlag: vi.fn(),
        getFlag: vi.fn(() => false),
        getThinkingLevel: vi.fn(() => "off"),
        sendMessage: vi.fn(),
        events: { emit: vi.fn(), on: vi.fn() },
      },
    );
    const ctx = extensionContextFixture({
      cwd,
      mode: "rpc",
      hasUI: true,
      model: { provider: "openai", id: "gpt-5.5" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getProviderAuth: () => Promise.resolve(undefined),
      },
      ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        buildContextEntries: () => [],
        getLeafId: () => null,
        getCwd: () => cwd,
        getSessionName: () => undefined,
      },
      getContextUsage: () => ({ contextWindow: 100, percent: 1 }),
      getSystemPrompt: () => "system",
      isProjectTrusted: vi.fn(() => true),
    });
    betterOpenAIWithDependencies(host.pi, options.dependencies);
    return {
      ...host,
      ctx,
      cwd,
      tools: host.registrations,
      emit: <Event>(name: string, event?: Event, useCtx: ExtensionContext = ctx) =>
        Effect.promise(() => host.emit(name, useCtx, event)),
    };
  });
