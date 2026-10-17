import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { registerExtensionCommand, type ExtensionSubcommand } from "../src/host-command.ts";
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
  const complete = (prefix: string) =>
    Effect.promise(() => Promise.resolve(registered?.getArgumentCompletions?.(prefix)));
  return { command, notify, ctx, run, complete };
};

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
});
