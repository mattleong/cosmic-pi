import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import {
  decodeCosmicUiSettingChange,
  recoverSettingsUpdate,
  registerSettingsCommand,
} from "../src/settings/controller.ts";

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
    registerSettingsCommand({ registerCommand } as unknown as ExtensionAPI, {
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
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    };
    const ctx = Object.defineProperty({ ui: { notify } }, "mode", {
      get() {
        throw new Error("mode host failure");
      },
    }) as unknown as ExtensionContext;

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
    registerSettingsCommand({ registerCommand } as unknown as ExtensionAPI, {
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
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    };
    const base = {
      mode: "tui",
      signal: new AbortController().signal,
      ui: { notify },
    };

    return expect(
      Promise.resolve(
        command.handler("", {
          ...base,
          ui: {
            notify,
            custom() {
              throw new Error("custom host failure");
            },
          },
        } as unknown as ExtensionContext),
      ),
    )
      .resolves.toBeUndefined()
      .then(() =>
        expect(
          Promise.resolve(
            command.handler("", {
              ...base,
              ui: {
                notify,
                custom: () => Promise.reject(new Error("custom host rejection")),
              },
            } as unknown as ExtensionContext),
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
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let factory: ((...args: any[]) => { render(width: number): string[] }) | undefined;
    registerSettingsCommand({ registerCommand } as unknown as ExtensionAPI, {
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
    const command = registerCommand.mock.calls[0]?.[1] as {
      handler(args: string, ctx: ExtensionContext): void | Promise<void>;
    };
    const ctx = Object.defineProperty(
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
    ) as unknown as ExtensionContext;

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
