import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import {
  completeExtensionCommand,
  registerExtensionCommand,
  routeExtensionCommand,
  type ExtensionSubcommand,
} from "../src/host-command.ts";
import { extensionApiFixture, extensionContextFixture } from "../src/testing/host.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

const subcommand = (name: string, overrides: Partial<ExtensionSubcommand> = {}) => ({
  name,
  description: `${name} description`,
  handler: vi.fn(),
  ...overrides,
});

const harness = (options: Partial<Parameters<typeof registerExtensionCommand>[1]> = {}) => {
  let registered: Command | undefined;
  const command = registerExtensionCommand(
    extensionApiFixture({
      registerCommand: (_name: string, definition: Command) => {
        registered = definition;
      },
    }),
    { name: "demo", description: "Demo extension", ...options },
  );
  const notify = vi.fn();
  const ctx = extensionContextFixture({ hasUI: true, ui: { notify } });
  const run = (args: string) =>
    Effect.promise(() => Promise.resolve(registered?.handler(args, ctx)));
  const attempt = (args: string) =>
    Effect.tryPromise({
      try: () => Promise.resolve(registered?.handler(args, ctx)),
      catch: (cause) => String(cause),
    });
  const complete = (prefix: string) =>
    Effect.promise(() => Promise.resolve(registered?.getArgumentCompletions?.(prefix)));
  return { command, notify, ctx, run, attempt, complete };
};

describe("extension command routing", () => {
  const usage = subcommand("usage");
  const settings = subcommand("settings");

  it("sends each argument text to the part that owns it", () => {
    expect(routeExtensionCommand("  settings  a b ", [usage, settings])).toEqual({
      _tag: "Subcommand",
      subcommand: settings,
      args: "a b",
    });
    expect(routeExtensionCommand("", [usage])._tag).toBe("Overview");
    expect(routeExtensionCommand("unknown", [usage])._tag).toBe("Unknown");
    // Names match exactly; a prompt that merely starts like one stays text.
    expect(routeExtensionCommand("usages", [usage])._tag).toBe("Unknown");
    const bare = { handler: vi.fn() };
    expect(routeExtensionCommand("", [usage], bare)).toEqual({ _tag: "Bare", args: "" });
    expect(routeExtensionCommand("explain this", [usage], bare)._tag).toBe("Unknown");
    expect(routeExtensionCommand("explain this", [usage], { ...bare, text: true })).toEqual({
      _tag: "Bare",
      args: "explain this",
    });
  });

  it("completes names, then the named subcommand's own arguments", () => {
    const withValues = subcommand("settings", {
      complete: (prefix) =>
        ["mode", "limit"]
          .filter((id) => id.startsWith(prefix))
          .map((id) => ({ value: id, label: id })),
    });
    expect(completeExtensionCommand("", [usage, withValues])?.map((c) => c.value)).toEqual([
      "usage",
      "settings",
    ]);
    expect(completeExtensionCommand("SE", [usage, withValues])?.map((c) => c.value)).toEqual([
      "settings",
    ]);
    expect(completeExtensionCommand("settings m", [usage, withValues])).toEqual([
      { value: "settings mode", label: "mode" },
    ]);
    expect(completeExtensionCommand("settings x", [usage, withValues])).toBeNull();
    expect(completeExtensionCommand("usage ", [usage, withValues])).toBeNull();
    expect(completeExtensionCommand("nothing", [usage])).toBeNull();
  });
});

describe("registered extension command", () => {
  it.effect("runs subcommands, lists them when bare, and warns about unknown ones", () =>
    Effect.gen(function* () {
      const usage = subcommand("usage");
      const h = harness({ subcommands: [usage] });
      yield* h.run("usage now");
      expect(usage.handler).toHaveBeenCalledWith("now", h.ctx);
      yield* h.run("");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("usage"), "info");
      yield* h.run("nope");
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("usage"), "warning");
    }),
  );

  it.effect("adds subcommands later and replaces one by name in place", () =>
    Effect.gen(function* () {
      const first = subcommand("image");
      const h = harness({ subcommands: [subcommand("usage")] });
      h.command.add(first);
      h.command.add(subcommand("settings"));
      const replacement = subcommand("image");
      h.command.add(replacement);
      const names = (yield* h.complete(""))?.map((choice) => choice.value);
      expect(names).toEqual(["usage", "image", "settings"]);
      yield* h.run("image an otter");
      expect(first.handler).not.toHaveBeenCalled();
      expect(replacement.handler).toHaveBeenCalledWith("an otter", h.ctx);
    }),
  );

  it.effect("turns a subcommand that throws into a rejected command", () =>
    Effect.gen(function* () {
      const failing = subcommand("usage", {
        handler: () => {
          throw new Error("boom");
        },
      });
      const h = harness({ subcommands: [failing] });
      const failure = yield* Effect.flip(h.attempt("usage"));
      expect(failure).toContain("boom");
    }),
  );
});
