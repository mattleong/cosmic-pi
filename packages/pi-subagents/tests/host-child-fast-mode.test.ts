import type { OpenAIFastMode } from "pi-better-openai/fast-models";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vitest";
import { childProcessEnvironment } from "../src/boundary/child-process.ts";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import { backendLaunch } from "./fixtures/backend-launch.ts";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";

afterEach(() => vi.unstubAllEnvs());

const requestContext = (
  id = "gpt-6.2-sol",
  provider = "openai-codex",
  baseUrl = "https://chatgpt.com/backend-api/codex",
) =>
  extensionContextFixture({
    model: modelFixture({ provider, id, api: "openai-codex-responses", baseUrl }),
  });

const requestHarness = (
  openaiFastMode?: OpenAIFastMode,
  legacyFlag: () => string | boolean | undefined = () => undefined,
) => {
  const child =
    openaiFastMode === undefined
      ? { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_OPENAI_FAST_MODE: undefined }
      : childProcessEnvironment(
          { PI_SUBAGENT_OPENAI_FAST_MODE: "ultrafast" },
          backendLaunch({ openaiFastMode }),
        );
  vi.stubEnv("PI_SUBAGENT_CHILD", child.PI_SUBAGENT_CHILD);
  vi.stubEnv("PI_SUBAGENT_OPENAI_FAST_MODE", child.PI_SUBAGENT_OPENAI_FAST_MODE);
  vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", undefined);
  vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", undefined);
  const host = recordingExtensionHost(
    {},
    { getFlag: (name) => (name === "pi-subagents-fast-mode" ? legacyFlag() : undefined) },
  );
  registerSubagentChildBridge(host.pi, {
    loadSettings: () => Promise.resolve(),
    openIpc: () => ({
      sendContact: () => Effect.die("No IPC is expected during request-hook tests"),
      listen: () => {
        throw new Error("No listener is expected before session start");
      },
    }),
  });
  return {
    request: (payload: { readonly input: string }, ctx = requestContext()) =>
      host.handlers.get("before_provider_request")[0]?.(
        { type: "before_provider_request", payload },
        ctx,
      ),
    headers: (ctx = requestContext()) => {
      const headers = {};
      return Effect.promise(() =>
        host.emit("before_provider_headers", ctx, { type: "before_provider_headers", headers }),
      ).pipe(Effect.as(headers));
    },
  };
};

describe("child route's fast mode", () => {
  it.effect("never inherits another agent's tier and keeps boolean true at priority", () =>
    Effect.gen(function* () {
      const payload = Object.freeze({ input: "task" });
      const off = requestHarness(false, () => true);
      expect(off.request(payload)).toBeUndefined();
      expect(yield* off.headers()).toEqual({});
      const priority = requestHarness(true);
      expect(priority.request(payload)).toMatchObject({ service_tier: "priority" });
      expect(payload).toEqual({ input: "task" });
    }),
  );

  it("still observes the priority switch from an already-running older launcher", () => {
    let flag: string | boolean | undefined;
    const harness = requestHarness(undefined, () => flag);
    const payload = { input: "task" };
    expect(harness.request(payload)).toBeUndefined();
    flag = true;
    expect(harness.request(payload)).toMatchObject({ service_tier: "priority" });
    flag = "true";
    expect(harness.request(payload)).toBeUndefined();
  });

  it.effect("applies ultrafast only on eligible Sol and sends the routing hint only to Codex", () =>
    Effect.gen(function* () {
      const harness = requestHarness("ultrafast");
      const payload = { input: "task" };
      expect(harness.request(payload)).toMatchObject({ service_tier: "ultrafast" });
      expect(yield* harness.headers()).not.toEqual({});
      for (const ineligible of [
        requestContext("gpt-other"),
        requestContext("gpt-6.2-sol", "openai"),
      ]) {
        expect(harness.request(payload, ineligible)).toBeUndefined();
        expect(yield* harness.headers(ineligible)).toEqual({});
      }
      const proxy = requestContext("gpt-6.2-sol", "openai-codex", "https://private.invalid");
      expect(harness.request(payload, proxy)).toMatchObject({ service_tier: "ultrafast" });
      expect(yield* harness.headers(proxy)).toEqual({});
    }),
  );
});
