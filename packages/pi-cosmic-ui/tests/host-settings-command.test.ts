import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  registerSettingsCommand,
  type SettingsCommandOptions,
} from "../src/boundary/host-settings-command.ts";

interface DemoConfig {
  readonly mode: string;
}
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Options = SettingsCommandOptions<DemoConfig>;

const harness = (
  overrides: Partial<Options> = {},
  context: { readonly mode?: string; readonly signal?: AbortSignal } = {},
) => {
  let command: Command | undefined;
  const notify = vi.fn();
  const apply = vi.fn<Options["apply"]>(() => Promise.resolve(Result.succeed(undefined)));
  const open = vi.fn<Options["open"]>(() =>
    Promise.resolve({ _tag: "Settled" as const, value: undefined }),
  );
  const pi = extensionApiFixture({
    registerCommand: (_name: string, registered: Command) => {
      command = registered;
    },
  });
  registerSettingsCommand(pi, {
    command: "demo-settings",
    description: "Configure the demo provider",
    title: "Demo",
    descriptors: [
      {
        id: "mode",
        description: "Demo mode.",
        values: ["on", "off"],
        currentValue: (cfg: DemoConfig) => cfg.mode,
      },
    ],
    examples: ["mode on"],
    config: () => undefined,
    diagnostics: () => "demo diagnostics",
    apply,
    afterApply: () => undefined,
    open,
    ...overrides,
  });
  const ctx = extensionContextFixture({
    mode: context.mode ?? "tui",
    hasUI: true,
    signal: context.signal,
    ui: { notify, custom: () => Promise.resolve(undefined) },
  });
  const invoke = (args: string) =>
    Effect.promise(() => Promise.resolve(command?.handler(args, ctx)));
  const throwOnSignal = () =>
    Object.defineProperty(ctx, "signal", {
      configurable: true,
      get() {
        throw new Error("host-signal-secret");
      },
    });
  return { ctx, notify, apply, open, invoke, throwOnSignal };
};

describe("provider settings command shell", () => {
  it.effect("answers help, diagnostics, and invalid input without config or apply", () =>
    Effect.gen(function* () {
      let failDiagnostics = false;
      const h = harness({
        diagnostics: () => {
          if (failDiagnostics) throw new Error("diagnostics-secret");
          return "demo diagnostics";
        },
      });
      yield* h.invoke("help");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "info");
      yield* h.invoke("diagnostics");
      expect(h.notify).toHaveBeenLastCalledWith("demo diagnostics", "info");
      failDiagnostics = true;
      yield* h.invoke("diagnostics");
      expect(h.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("secret"), "warning");
      yield* h.invoke("unknown on");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("unknown"), "error");
      yield* h.invoke("mode");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "error");
      yield* h.invoke("mode maybe");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "error");
      h.open.mockResolvedValueOnce({ _tag: "Blocked" });
      yield* h.invoke("");
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
      expect(h.apply).not.toHaveBeenCalled();

      const headless = harness({}, { mode: "rpc" });
      yield* headless.invoke("");
      expect(headless.open).not.toHaveBeenCalled();
      expect(headless.notify).toHaveBeenLastCalledWith(expect.stringContaining("mode"), "info");
    }),
  );

  it.effect("binds the signal by the provider's policy", () =>
    Effect.gen(function* () {
      const required = harness();
      required.throwOnSignal();
      yield* required.invoke("mode on");
      yield* required.invoke("");
      expect(required.apply).not.toHaveBeenCalled();
      expect(required.open).not.toHaveBeenCalled();
      expect(required.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");

      const optional = harness({ signal: "optional" });
      optional.throwOnSignal();
      yield* optional.invoke("mode on");
      expect(optional.apply.mock.calls.map(([, id, value, signal]) => [id, value, signal])).toEqual(
        [["mode", "on", undefined]],
      );

      const aborted = harness({ signal: "optional" }, { signal: AbortSignal.abort() });
      aborted.apply.mockRejectedValueOnce(new Error("interrupted"));
      yield* aborted.invoke("mode on");
      expect(aborted.notify).not.toHaveBeenCalled();

      // A required signal stays the opening one; an optional one is reread for each picker apply.
      const opening = AbortSignal.abort("opening");
      const later = AbortSignal.abort("later");
      for (const policy of ["required", "optional"] as const) {
        const h = harness({ signal: policy }, { signal: opening });
        h.open.mockImplementationOnce((_ctx, session) => {
          Object.defineProperty(h.ctx, "signal", { configurable: true, value: later });
          return session
            .apply("mode", "on")
            .then(() => ({ _tag: "Settled" as const, value: undefined }));
        });
        yield* h.invoke("");
        expect(h.apply.mock.calls[0]?.[3]).toBe(policy === "optional" ? later : opening);
      }
    }),
  );
});
