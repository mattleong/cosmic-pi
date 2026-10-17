import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";

type FastModeFlag = boolean | string | undefined;
type RequestPayload =
  | { readonly input: string; readonly service_tier?: string }
  | string
  | number
  | null
  | undefined
  | ReadonlyArray<never>;

beforeEach(() => {
  vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", undefined);
  vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", undefined);
});
afterEach(() => vi.unstubAllEnvs());

const requestContext = (provider = "openai-codex", id = "gpt-5.6-sol") =>
  extensionContextFixture({ model: modelFixture({ provider, id }) });

const requestHarness = () => {
  let fastMode: FastModeFlag = false;
  const host = recordingExtensionHost(
    {},
    {
      registerFlag: vi.fn(),
      getFlag: (name) => (name === "pi-subagents-fast-mode" ? fastMode : undefined),
    },
  );
  return {
    pi: host.pi,
    setFastMode: (value: FastModeFlag) => {
      fastMode = value;
    },
    request: (payload: RequestPayload, ctx: ExtensionContext = requestContext()) => {
      const handler = host.handlers.get("before_provider_request")?.[0];
      if (!handler) throw new Error("Missing request hook");
      return handler({ type: "before_provider_request", payload }, ctx);
    },
  };
};

const registerLocal = (pi: ExtensionAPI) =>
  registerSubagentChildBridge(pi, {
    loadSettings: () => Promise.resolve(),
    openIpc: () => ({
      sendContact: () => Effect.die("No IPC is expected during request-hook tests"),
      listen: () => {
        throw new Error("No listener is expected before session start");
      },
    }),
  });
describe("local child fast-mode flag", () => {
  it("uses flags applied after registration and observes later disabling", () => {
    const harness = requestHarness();
    registerLocal(harness.pi);
    const payload = Object.freeze({ input: "task" });
    expect(harness.request(payload)).toBeUndefined();

    harness.setFastMode(true);
    expect(harness.request(payload)).toEqual({ ...payload, service_tier: "priority" });
    expect(payload).toEqual({ input: "task" });

    harness.setFastMode(false);
    expect(harness.request(payload)).toBeUndefined();
    harness.setFastMode("true");
    expect(harness.request(payload)).toBeUndefined();
    harness.setFastMode(undefined);
    expect(harness.request(payload)).toBeUndefined();
  });
});
