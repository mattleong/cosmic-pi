import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { afterEach, beforeEach, vi } from "vitest";
import { askUserWithDependencies } from "../../src/application.ts";

export type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

export const withoutRelayMarker = () => {
  beforeEach(() => {
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    vi.stubEnv("PI_SUBAGENT_RUN_ID", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
};

export const startExtension = (
  load: (cwd: string, projectTrusted: boolean, signal?: AbortSignal) => PromiseLike<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ask-user-agent-" });
    yield* Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory));
    const sendMessage = vi.fn(
      (
        _message: Parameters<ExtensionAPI["sendMessage"]>[0],
        _options?: Parameters<ExtensionAPI["sendMessage"]>[1],
      ) => undefined,
    );
    const appendEntry = vi.fn(<Data>(_customType: string, _data?: Data) => undefined);
    const host = recordingExtensionHost({}, { events: createEventBus(), sendMessage, appendEntry });
    askUserWithDependencies(host.pi, load);
    return { ...host, sendMessage, appendEntry };
  });
