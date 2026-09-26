// Synchronous Pi request-hook boundary tests. No session or provider request is started.
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import { registerChildPiFastModeHook } from "../src/boundary/host-child-pi.ts";
import registerSupervisorBridge from "../src/boundary/host-pi-supervisor-extension.ts";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { extensionApiFixture, modelFixture } from "./fixtures/pi-host.ts";

type Handler = ExtensionHandler<any, any>;
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
  const handlers = new Map<string, Handler>();
  let fastMode: FastModeFlag = false;
  const pi = extensionApiFixture({
    registerFlag: vi.fn(),
    getFlag: (name: string) => (name === "pi-subagents-fast-mode" ? fastMode : undefined),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
  });
  return {
    pi,
    setFastMode: (value: FastModeFlag) => {
      fastMode = value;
    },
    request: (payload: RequestPayload, ctx: ExtensionContext = requestContext()) => {
      const handler = handlers.get("before_provider_request");
      if (!handler) throw new Error("Missing request hook");
      return handler({ payload }, ctx);
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
const registerSupervisor = (pi: ExtensionAPI) =>
  registerSupervisorBridge(pi, {
    openBridge: () => Effect.die("No supervisor connection is expected before session start"),
  });

describe.each([
  { name: "local child", register: registerLocal },
  { name: "delegated child", register: registerSupervisor },
])("$name fast-mode flag", ({ register }) => {
  it("uses flags applied after registration and observes later disabling", () => {
    const harness = requestHarness();
    register(harness.pi);
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

describe("private Pi priority eligibility", () => {
  it("checks the current provider and model without changing unrelated payloads", () => {
    const harness = requestHarness();
    registerChildPiFastModeHook(harness.pi, () => true);
    const payload = Object.freeze({ service_tier: "existing", input: "task" });
    expect(harness.request(payload, requestContext("anthropic"))).toBeUndefined();
    expect(harness.request(payload, requestContext("openai-codex", ""))).toBeUndefined();
    expect(harness.request(payload, extensionContextFixture({ model: undefined }))).toBeUndefined();
    expect(harness.request(payload)).toEqual({ ...payload, service_tier: "priority" });
    expect(payload.service_tier).toBe("existing");
  });

  it.each([
    { payload: null },
    { payload: undefined },
    { payload: "text" },
    { payload: 1 },
    { payload: [] },
  ])("leaves non-record payload $payload alone", ({ payload }) => {
    const harness = requestHarness();
    registerChildPiFastModeHook(harness.pi, () => true);
    expect(harness.request(payload)).toBeUndefined();
  });
});
