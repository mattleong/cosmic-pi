import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Arr from "effect/Array";
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
  const notify = vi.fn<(message: string, level?: string) => void>();
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

  it.effect("shows the overview for help, listing what the bare command does first", () =>
    Effect.gen(function* () {
      const bare = vi.fn();
      const h = harness({
        bare: { handler: bare, description: "Open the demo" },
        subcommands: [subcommand("usage")],
      });
      yield* h.run("help");
      expect(bare).not.toHaveBeenCalled();
      const [text = "", level] = h.notify.mock.lastCall ?? [];
      expect(level).toBe("info");
      expect(text).not.toContain("Unknown");
      const body = lines(text).slice(1);
      expect(body[0]).toContain("/demo ");
      expect(body[0]).toContain("Open the demo");
      expect(body[1]).toContain("usage description");
      // Unknown words still warn, and the overview they show lists the bare action too.
      yield* h.run("nope");
      expect(h.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("Open the demo"),
        "warning",
      );
    }),
  );

  it.effect("keeps a free-text command's text that starts with help", () =>
    Effect.gen(function* () {
      const bare = vi.fn();
      const h = harness({ bare: { handler: bare, text: true, description: "Ask a question" } });
      yield* h.run("help me debug the login flow");
      expect(bare).toHaveBeenCalledWith("help me debug the login flow", h.ctx);
      expect(h.notify).not.toHaveBeenCalled();
      yield* h.run("help");
      expect(bare).toHaveBeenCalledTimes(1);
      expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Ask a question"), "info");
    }),
  );

  it.effect("lets a command replace the built-in help", () =>
    Effect.gen(function* () {
      const help = subcommand("help");
      const h = harness({ subcommands: [help] });
      yield* h.run("help topics");
      expect(help.handler).toHaveBeenCalledWith("topics", h.ctx);
      expect(h.notify).not.toHaveBeenCalled();
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
      expect(names).toEqual(["usage", "image", "settings", "help"]);
      yield* h.run("image an otter");
      expect(first.handler).not.toHaveBeenCalled();
      expect(replacement.handler).toHaveBeenCalledWith("an otter", h.ctx);
    }),
  );
});

const PHONE_COLUMNS = 55;
const lines = (text: string) => Str.split(text, "\n");
const words = (text: string) => Arr.join(Str.split(Str.trim(text), /\s+/u), " ");

describe("bare command overview", () => {
  const overviews: ReadonlyArray<Parameters<typeof extensionCommandOverview>> = [
    [
      "demo",
      "Demo extension",
      [
        { name: "list", description: "List things" },
        { name: "receive", arguments: "[on|off]", description: "Allow or block" },
      ],
      ["An example follows:", '  "Ask the demo"'],
    ],
    [
      "a-rather-long-command",
      "An extension whose description alone runs well past the width of a phone client",
      [
        { name: "settings", description: "Configure every last aspect of how this behaves" },
        { name: "health", description: "Short" },
      ],
    ],
    [
      "subagents",
      "Manage subagents",
      [
        {
          name: "settings",
          arguments: "[session|global|project] <id> <value>",
          description: "Change one setting",
        },
      ],
    ],
  ];

  for (const [name, description, subcommands, notes = []] of overviews)
    it(`fits /${name} on a phone without losing a usage, description, or note`, () => {
      const text = extensionCommandOverview(name, description, subcommands, notes);
      expect(Arr.every(lines(text), (line) => line.length <= PHONE_COLUMNS)).toBe(true);
      expect(words(text)).toBe(
        words(
          Arr.join(
            [
              `/${name}: ${description}`,
              ...Arr.flatMap(subcommands, (entry) => [
                `/${name} ${entry.name} ${entry.arguments ?? ""}`,
                entry.description,
              ]),
              ...notes,
            ],
            " ",
          ),
        ),
      );
    });
});
