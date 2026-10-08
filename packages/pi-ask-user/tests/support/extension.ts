import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { afterEach, beforeEach, vi } from "vitest";
import { askUserWithDependencies } from "../../src/application.ts";

export type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

/** Clears an inherited Pi child marker before each test; a test that needs one stubs it. */
export const withoutRelayMarker = () => {
  beforeEach(() => {
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    vi.stubEnv("PI_SUBAGENT_RUN_ID", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
};

/** The actual factory over a host whose public metadata names one source for every registration. */
export const startExtension = (
  load: (cwd: string, projectTrusted: boolean, signal?: AbortSignal) => PromiseLike<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-agent-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const host = recordingExtensionHost(
      {},
      { events: createEventBus(), sendMessage: vi.fn(), appendEntry: vi.fn() },
    );
    askUserWithDependencies(host.pi, load);
    return host;
  });
