import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { vi } from "vitest";
import {
  extensionCommandOverview,
  registerExtensionCommand,
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
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("nope"), "warning");
      // The overview follows, so the user sees every command they could have meant.
      expect(h.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("usage description"),
        "warning",
      );
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
      const names = Option.getOrUndefined(
        Option.map(Option.fromNullishOr(yield* h.complete("")), (choices) =>
          Arr.map(choices, (choice) => choice.value),
        ),
      );
      expect(names).toEqual(["usage", "image", "settings"]);
      yield* h.run("image an otter");
      expect(first.handler).not.toHaveBeenCalled();
      expect(replacement.handler).toHaveBeenCalledWith("an otter", h.ctx);
    }),
  );
});

const PHONE_COLUMNS = 55;
const lines = (text: string) => Str.split(text, "\n");
const fitsPhone = (text: string) => Arr.every(lines(text), (line) => line.length <= PHONE_COLUMNS);

describe("bare command overview", () => {
  it("aligns descriptions in one column and keeps trailing notes", () => {
    const text = extensionCommandOverview(
      "demo",
      "Demo extension",
      [
        { name: "list", description: "List things" },
        { name: "receive", arguments: "[on|off]", description: "Allow or block" },
      ],
      ["An example follows:", '  "Ask the demo"'],
    );
    const [, first = "", second = ""] = lines(text);
    expect(Str.indexOf("List things")(first)).toEqual(Str.indexOf("Allow or block")(second));
    expect(Fn.pipe(text, Str.endsWith('An example follows:\n  "Ask the demo"'))).toBe(true);
    expect(fitsPhone(text)).toBe(true);
  });

  it("moves descriptions beneath their commands when a line wouldn't fit a phone", () => {
    const text = extensionCommandOverview(
      "a-rather-long-command",
      "An extension whose description alone runs well past the width of a phone client",
      [
        { name: "settings", description: "Configure every last aspect of how this behaves" },
        { name: "health", description: "Short" },
      ],
    );
    const body = lines(text).slice(1);
    expect(fitsPhone(text)).toBe(true);
    // Nothing wraps back to the left edge: every continuation is indented.
    expect(Arr.every(body, Str.startsWith("  "))).toBe(true);
    expect(body).toContain("  /a-rather-long-command health");
    expect(body).toContain("    Short");
  });
});
