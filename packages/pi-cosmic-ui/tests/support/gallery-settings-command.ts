import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { SelectList } from "@earendil-works/pi-tui";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { settingsSubcommand } from "../../src/boundary/host-settings-command.ts";
import { OwnedSurfaceOutcome } from "../../src/boundary/host-surface.ts";

interface DemoConfig {
  readonly fast: string;
  readonly refresh: string;
}

// Shaped like `/openai settings` (open values, long descriptions) and `/tasks settings` (scopes and
// a reload note), so the gallery shows both forms of command text.
const commands = {
  openai: settingsSubcommand<DemoConfig>({
    root: "openai",
    description: "Configure Better OpenAI",
    title: "Better OpenAI",
    isCurrent: () => true,
    descriptors: [
      {
        id: "fast.enabled",
        label: "Fast mode",
        description: "Request OpenAI fast mode for any openai or openai-codex model.",
        values: ["on", "off"],
        openValues: true,
        currentValue: (config) => config.fast,
      },
      {
        id: "usage.refreshIntervalMs",
        label: "Refresh interval",
        description: "How often subscription usage refreshes.",
        values: ["30s", "1m", "5m"],
        openValues: true,
        currentValue: (config) => config.refresh,
      },
    ],
    examples: ["fast.enabled on", "usage.refreshIntervalMs 30s"],
    config: () => ({ fast: "on", refresh: "1m" }),
    status: undefined,
    apply: () => Promise.resolve(Result.succeed(undefined)),
    open: () => Promise.resolve(OwnedSurfaceOutcome.Settled({ value: undefined })),
  }),
  tasks: settingsSubcommand<DemoConfig>({
    root: "tasks",
    description: "Background task settings",
    title: "Background Tasks",
    isCurrent: () => true,
    descriptors: [
      {
        id: "maxRunning",
        label: "Running at once",
        description: "How many tasks run at the same time; later ones wait.",
        values: ["4", "8", "16", "inherit"],
        currentValue: () => "inherit (8)",
      },
      {
        id: "logBufferBytesPerTask",
        label: "Log buffer per task",
        description: "Recent output kept in memory for each task.",
        values: ["256KiB", "1MiB", "inherit"],
        openValues: true,
        currentValue: () => "256 KB",
      },
    ],
    examples: ["maxRunning 16", "project logBufferBytesPerTask 1MiB"],
    notes: () => [
      "Scope defaults to global; inherit removes a scope's own value. Changes apply after /reload.",
    ],
    confirmationNote: "applies after /reload",
    scopes: [
      { name: "global", description: "Everywhere" },
      { name: "project", description: "This project" },
    ],
    config: () => ({ fast: "on", refresh: "1m" }),
    status: undefined,
    displayValue: (_ctx, id) => (id === "maxRunning" ? "16" : undefined),
    apply: () => Promise.resolve(Result.succeed(undefined)),
    open: () => Promise.resolve(OwnedSurfaceOutcome.Settled({ value: undefined })),
  }),
};

const scenarios: ReadonlyArray<readonly [keyof typeof commands, string, string]> = [
  ["openai", "help", "help"],
  ["openai", "status", "status"],
  ["openai", "missing value", "fast.enabled"],
  ["openai", "unknown setting", "fast.enable on"],
  ["tasks", "help with scopes", "help"],
  ["tasks", "missing value in a scope", "project maxRunning"],
  ["tasks", "missing setting and value", "project"],
  ["tasks", "invalid value", "maxRunning 3"],
  ["tasks", "command-line change confirms with its note", "global maxRunning 16"],
];

// Pi leads a warning or error with its level.
const NOTICE_PREFIX = { info: "", warning: "Warning: ", error: "Error: " };
const noticePrefix = (level: string): string =>
  level === "warning" || level === "error" ? NOTICE_PREFIX[level] : NOTICE_PREFIX.info;

// Pi wraps an overlong notice line at the terminal edge with no indent.
const edgeWrap = (line: string, width: number): string[] =>
  line.length <= width
    ? [line]
    : [Fn.pipe(line, Str.slice(0, width)), ...edgeWrap(Fn.pipe(line, Str.slice(width)), width)];

/**
 * `/<ext> settings` help, status, errors, and confirmations as notices. Pi draws a notice one
 * column in and wraps at the edge, so each is shown in a 57-column and a 100-column frame.
 */
export const settingsCommandGalleryLines = Effect.fn("settingsCommandGalleryLines")(function* () {
  const lines: string[] = [];
  for (const [name, label, args] of scenarios) {
    const notices: Array<readonly [string, string]> = [];
    const ctx = extensionContextFixture({
      mode: "rpc",
      hasUI: true,
      ui: { notify: (message: string, level = "info") => void notices.push([message, level]) },
    });
    yield* Effect.promise(() => Promise.resolve(commands[name].handler(args, ctx)));
    for (const width of [57, 100])
      lines.push(
        `── Settings command · /${name} settings ${args} · ${label} · ${width} cols`,
        ...Arr.flatMap(notices, ([message, level]) =>
          Arr.flatMap(Str.split(message, "\n"), (line, index) =>
            edgeWrap(` ${index === 0 ? noticePrefix(level) : ""}${line}`, width),
          ),
        ),
        "",
      );
  }
  return lines;
});

const plainSelectTheme = {
  selectedPrefix: Fn.identity<string>,
  selectedText: Fn.identity<string>,
  description: Fn.identity<string>,
  scrollInfo: Fn.identity<string>,
  noMatch: Fn.identity<string>,
};

// Pi's editor lists slash-command arguments in a SelectList with this primary-column range.
const SLASH_COMMAND_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };

const completionScenarios: ReadonlyArray<readonly [keyof typeof commands, string]> = [
  ["tasks", ""],
  ["tasks", "project "],
  ["tasks", "maxRunning "],
  ["openai", ""],
];

/** `/<ext> settings ` autocomplete, as Pi's editor lists it, in a 57- and a 100-column frame. */
export const settingsCompletionGalleryLines = (): string[] =>
  Arr.flatMap(completionScenarios, ([name, prefix]) => {
    const items = commands[name].complete?.(prefix) ?? [];
    return Arr.flatMap([57, 100], (width) => [
      `── Settings autocomplete · /${name} settings ${prefix}· ${width} cols`,
      ...new SelectList([...items], 10, plainSelectTheme, SLASH_COMMAND_LAYOUT).render(width),
      "",
    ]);
  });
