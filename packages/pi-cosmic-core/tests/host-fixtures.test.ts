import { SessionManager, type SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  extensionContextFixture,
  modelFixture,
  modelRegistryFixture,
  recordingExtensionHost,
  sessionManagerFixture,
  themeFixture,
} from "../testing.ts";

it("keeps override getters lazy and merges partial UI over inert defaults", () => {
  let cwdReads = 0;
  const setStatus = vi.fn();
  const ctx = extensionContextFixture({
    get cwd() {
      cwdReads += 1;
      return "/live";
    },
    ui: { setStatus },
  });
  expect(cwdReads).toBe(0);
  expect(ctx.cwd).toBe("/live");
  expect(cwdReads).toBe(1);
  ctx.ui.setStatus("fixture", "ready");
  expect(setStatus).toHaveBeenCalledWith("fixture", "ready");
  expect(ctx.ui.getEditorText()).toBe("");
});

it("derives a coherent UI mode and session cwd from declared values", () => {
  expect(extensionContextFixture()).toMatchObject({ mode: "print", hasUI: false });
  expect(extensionContextFixture({ hasUI: true })).toMatchObject({ mode: "tui", hasUI: true });
  expect(extensionContextFixture({ mode: "rpc" })).toMatchObject({ mode: "rpc", hasUI: true });
  expect(extensionContextFixture({ cwd: "/work" }).sessionManager.getCwd()).toBe("/work");
});

it.effect("never resolves host credentials from the environment", () =>
  Effect.gen(function* () {
    vi.stubEnv("OPENAI_API_KEY", "sk-fixture");
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const registry = modelRegistryFixture();
    const model = modelFixture({ provider: "openai", id: "gpt-5.5" });
    expect(yield* Effect.promise(() => registry.getApiKeyAndHeaders(model))).toMatchObject({
      ok: false,
    });
    expect(registry.hasConfiguredAuth(model)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("delivers default and explicit events to live handlers only", () =>
  Effect.gen(function* () {
    const host = recordingExtensionHost();
    const ctx = extensionContextFixture();
    const received: Array<SessionStartEvent["reason"]> = [];
    const unsubscribe = host.pi.on("session_start", (event) => {
      received.push(event.reason);
    });
    yield* Effect.promise(() => host.emit("session_start", ctx));
    yield* Effect.promise(() =>
      host.emit("session_start", ctx, { type: "session_start", reason: "reload" }),
    );
    unsubscribe();
    yield* Effect.promise(() => host.emit("session_start", ctx));
    expect(received).toEqual(["startup", "reload"]);
  }),
);

it("builds a real Pi theme whose overridden styling can change between renders", () => {
  let marker = "old";
  const theme = themeFixture({
    fg: (color, text) => (color === "error" ? `${marker}:${text}` : text),
  });
  expect(theme.fg("error", "x")).toBe("old:x");
  marker = "new";
  expect(theme.fg("error", "x")).toBe("new:x");
  expect(theme.bold("y")).toBe("y");
  expect(theme.getColorMode()).toBe("truecolor");
});

it("uses complete class-instance overrides as-is and delegates partial ones", () => {
  const session = SessionManager.inMemory("/real");
  const ctx = extensionContextFixture({ sessionManager: session });
  expect(ctx.sessionManager).toBe(session);
  expect(ctx.sessionManager.getSessionId()).toBe(session.getSessionId());

  class PartialSession {
    readonly #id = "partial-session";
    getSessionId(): string {
      return this.#id;
    }
  }
  const partial = sessionManagerFixture(new PartialSession(), "/fallback");
  expect(partial.getSessionId()).toBe("partial-session");
  expect(partial.getCwd()).toBe("/fallback");
});
