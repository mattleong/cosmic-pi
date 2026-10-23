import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { recordingExtensionHost } from "pi-cosmic-core/testing";
import { afterEach, expect, vi } from "vitest";
import intercom from "../src/extension.ts";

afterEach(() => vi.unstubAllEnvs());

it.effect("skips application loading in a child, but retains root registration and replay", () =>
  Effect.gen(function* () {
    const load = vi.fn(() => import("../src/application.ts"));
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const child = recordingExtensionHost();
    yield* Effect.promise(() => Promise.resolve(intercom(child.pi, load)));
    expect(load).not.toHaveBeenCalled();
    expect(child.handlers.has("session_start")).toBe(false);
    expect(child.commands.size).toBe(0);
    expect(child.tools.size).toBe(0);
    expect(child.messageRenderers.size).toBe(0);

    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    const root = recordingExtensionHost();
    yield* Effect.promise(() => Promise.resolve(intercom(root.pi, load)));
    expect(load).toHaveBeenCalled();
    expect(root.handlers.has("session_start")).toBe(true);
    expect(root.commands.has("intercom")).toBe(true);
    expect(root.messageRenderers.size).toBeGreaterThan(0);
    expect(root.toolRenderers.length).toBeGreaterThan(0);
  }),
);
