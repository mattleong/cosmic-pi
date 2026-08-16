import { isFunctionValue } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import {
  decodeCosmicUiSettingChange,
  recoverSettingsUpdate,
  registerSettingsCommand,
} from "../src/settings/controller.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

describe("Cosmic UI settings boundary", () => {
  it("decodes only supported settings values and visibility identifiers", () => {
    expect(decodeCosmicUiSettingChange("enabled", "false")).toEqual({
      _tag: "UpdateFooter",
      patch: { enabled: false },
    });
    expect(decodeCosmicUiSettingChange("density", "compact")).toEqual({
      _tag: "UpdateFooter",
      patch: { density: "compact" },
    });
    expect(decodeCosmicUiSettingChange("mediaPlacement", "habitat")).toEqual({
      _tag: "UpdateFooter",
      patch: { mediaPlacement: "habitat" },
    });
    expect(decodeCosmicUiSettingChange("visible:metrics", "true")).toEqual({
      _tag: "SetVisibility",
      id: "metrics",
      visible: true,
    });
  });

  it("rejects malformed callback values instead of coercing or persisting them", () => {
    for (const [id, value] of [
      ["enabled", "sometimes"],
      ["density", "dense"],
      ["mediaPlacement", "floating"],
      ["visible:unknown", "true"],
      ["visible:metrics", "sometimes"],
      ["unknown", "true"],
      [42, "true"],
    ] as const) {
      expect(decodeCosmicUiSettingChange(id, value)).toBeUndefined();
    }
  });

  it("contains throwing notifications in both non-TUI and update recovery paths", () => {
    const registerCommand = vi.fn();
    const callbacks = makeHostCallbackBoundary(2);
    const updateContext = vi.fn();
    const notify = vi.fn((_message: string, _level: string) => {
      throw new Error("notification host failure");
    });
    // SAFETY: These scenarios ignore the generic run result; only settlement drives the command path.
    registerSettingsCommand(extensionApiFixture({ registerCommand }), {
      config: () => ({
        configPath: "/config.json",
        projectConfigPath: "/project/.pi/cosmic-ui.json",
        globalConfigPath: "/global/cosmic-ui.json",
        footer: DEFAULT_CONFIG.footer,
      }),
      updateContext,
      update: vi.fn(),
      run: <A>() => Promise.resolve(undefined as A),
      callbacks,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    };
    const ctx = extensionContextFixture(
      Object.defineProperty({ ui: { notify } }, "mode", {
        get() {
          throw new Error("mode host failure");
        },
      }),
    );

    return Promise.resolve(command.handler("", ctx))
      .then(() =>
        recoverSettingsUpdate(Promise.reject(new Error("update failure")), callbacks, () =>
          notify("Unable to update Cosmic UI configuration.", "error"),
        ),
      )
      .then(() => {
        expect(updateContext).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledTimes(2);
        expect(callbacks.diagnostics()).toEqual([{ operation: "notify" }, { operation: "notify" }]);
      });
  });

  it("contains synchronous and rejected settings host invocations", () => {
    const registerCommand = vi.fn();
    const callbacks = makeHostCallbackBoundary();
    const notify = vi.fn();
    // SAFETY: These scenarios ignore the generic run result; only settlement drives the command path.
    registerSettingsCommand(extensionApiFixture({ registerCommand }), {
      config: () => ({
        configPath: "/config.json",
        projectConfigPath: "/project/.pi/cosmic-ui.json",
        globalConfigPath: "/global/cosmic-ui.json",
        footer: DEFAULT_CONFIG.footer,
      }),
      updateContext: vi.fn(),
      update: vi.fn(),
      run: <A>() => Promise.resolve(undefined as A),
      callbacks,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    };
    const base = {
      mode: "tui",
      signal: new AbortController().signal,
      ui: { notify },
    };

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    return expect(
      Promise.resolve(
        command.handler(
          "",
          extensionContextFixture({
            ...base,
            ui: {
              notify,
              custom() {
                throw new Error("custom host failure");
              },
            },
          }),
        ),
      ),
    )
      .resolves.toBeUndefined()
      .then(() =>
        expect(
          Promise.resolve(
            command.handler(
              "",
              extensionContextFixture({
                ...base,
                ui: {
                  notify,
                  custom: () => Promise.reject(new Error("custom host rejection")),
                },
              }),
            ),
          ),
        ).resolves.toBeUndefined(),
      )
      .then(() => {
        expect(notify).toHaveBeenCalledTimes(2);
      });
  });

  it("snapshots the host signal once and contains a delayed settings factory", () => {
    const registerCommand = vi.fn();
    const callbacks = makeHostCallbackBoundary();
    const source = new AbortController().signal;
    let signalReads = 0;
    let abortedReads = 0;
    const addEventListener = vi.fn(source.addEventListener.bind(source));
    const removeEventListener = vi.fn(source.removeEventListener.bind(source));
    const signal = new Proxy(source, {
      get(target, property) {
        if (property === "aborted") abortedReads++;
        if (property === "addEventListener") return addEventListener;
        if (property === "removeEventListener") return removeEventListener;
        // SAFETY: The `in` check proves this proxy property belongs to the AbortSignal contract.
        const value = property in target ? target[property as keyof AbortSignal] : undefined;
        return isFunctionValue(value) ? value.bind(target) : value;
      },
    });
    let factory: ((...args: any[]) => { render(width: number): string[] }) | undefined;
    // SAFETY: These scenarios ignore the generic run result; only settlement drives the command path.
    registerSettingsCommand(extensionApiFixture({ registerCommand }), {
      config: () => ({
        configPath: "/config.json",
        projectConfigPath: "/project/.pi/cosmic-ui.json",
        globalConfigPath: "/global/cosmic-ui.json",
        footer: DEFAULT_CONFIG.footer,
      }),
      updateContext: vi.fn(),
      update: vi.fn(),
      run: <A>() => Promise.resolve(undefined as A),
      callbacks,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    };
    const ctx = extensionContextFixture(
      Object.defineProperty(
        {
          mode: "tui",
          ui: {
            notify: vi.fn(),
            custom: vi.fn((next) => {
              factory = next;
              return Promise.resolve();
            }),
          },
        },
        "signal",
        {
          get() {
            signalReads++;
            if (signalReads > 1) throw new Error("signal reread");
            return signal;
          },
        },
      ),
    );

    return Promise.resolve(command.handler("", ctx)).then(() => {
      expect(signalReads).toBe(1);
      expect(abortedReads).toBe(1);
      expect(addEventListener).toHaveBeenCalledOnce();
      expect(removeEventListener).toHaveBeenCalledOnce();
      const component = factory?.(
        { requestRender: vi.fn() },
        {
          fg: (_color: string, text: string) => text,
          bold() {
            throw new Error("theme host failure");
          },
        },
        {},
        vi.fn(),
      );
      expect(component?.render(80)).toEqual([]);
    });
  });
});
