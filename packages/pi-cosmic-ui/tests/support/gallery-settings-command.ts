import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { SelectList } from "@earendil-works/pi-tui";
import { clipText } from "pi-cosmic-core/display";
import { InvalidSettingError } from "pi-cosmic-core/settings-completion";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { registerCosmicUiApplication } from "../../src/application.ts";
import { settingsSubcommand } from "../../src/boundary/host-settings-command.ts";
import { OwnedSurfaceOutcome } from "../../src/boundary/host-surface.ts";
import { defaultResolvedCosmicUiConfig } from "../../src/config/schema.ts";
import { registerSettingsCommand } from "../../src/settings/controller.ts";

interface DemoConfig {
  readonly fast: string;
  readonly refresh: string;
}

// Owners reject values the way theirs do: Better OpenAI with an `InvalidSettingError` or its
// decoder's rule, background tasks with a plain message that leads with the id.
const openaiApply = (id: string, value: string) => {
  if (id === "fast.enabled" && value !== "on" && value !== "off")
    return Result.fail(InvalidSettingError.make({ id, message: `${id} must be on or off` }));
  if (id === "usage.refreshIntervalMs" && !/^\d+[sm]$/u.test(value))
    return Result.fail(
      InvalidSettingError.make({ id, message: `${id} can't be set to ${clipText(value, 24)}` }),
    );
  return Result.succeed(undefined);
};
const tasksApply = (id: string, value: string) => {
  if (id === "logBufferBytesPerTask" && value === "2MiB")
    return Result.fail({
      message:
        "Couldn't save background tasks settings: EACCES: permission denied, open '~/.pi/agent/extensions/pi-background-task.json'",
    });
  if (id === "logBufferBytesPerTask" && !/^\d+(?:KiB|MiB)$/u.test(value))
    return Result.fail({
      message: `${id} must be a size such as 256KB or 1MB, from 4KB to 4MB`,
    });
  return Result.succeed(undefined);
};

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
    apply: (_ctx, id, value) => Promise.resolve(openaiApply(id, value)),
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
    apply: (_ctx, id, value) => Promise.resolve(tasksApply(id, value)),
    open: () => Promise.resolve(OwnedSurfaceOutcome.Settled({ value: undefined })),
  }),
};

const scenarios: ReadonlyArray<readonly [keyof typeof commands, string, string]> = [
  ["openai", "help", "help"],
  ["openai", "status", "status"],
  ["openai", "missing value", "fast.enabled"],
  ["openai", "unknown setting", "fast.enable on"],
  ["openai", "invalid value the owner rejects", "fast.enabled maybe"],
  [
    "openai",
    "invalid value the decoder rejects, extreme input",
    `usage.refreshIntervalMs ${Str.repeat(24)("every-other-minute-")}`,
  ],
  ["tasks", "help with scopes", "help"],
  ["tasks", "missing value in a scope", "project maxRunning"],
  ["tasks", "missing setting and value", "project"],
  ["tasks", "invalid value", "maxRunning 3"],
  ["tasks", "invalid value the owner rejects", "project logBufferBytesPerTask 10x"],
  ["tasks", "save that couldn't be written stays an error", "logBufferBytesPerTask 2MiB"],
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

// Runs one command handler and draws the notices it posts in a 57- and a 100-column frame. Pi
// draws a notice one column in and wraps at the edge.
const noticeFrames = Effect.fn("noticeFrames")(function* (
  title: string,
  run: (ctx: ExtensionCommandContext) => Promise<void> | void,
) {
  const notices: Array<readonly [string, string]> = [];
  const ctx = extensionContextFixture({
    mode: "rpc",
    hasUI: true,
    ui: { notify: (message: string, level = "info") => void notices.push([message, level]) },
  });
  yield* Effect.promise(() => Promise.resolve(run(ctx)));
  return Arr.flatMap([57, 100], (width) => [
    `── ${title} · ${width} cols`,
    ...Arr.flatMap(notices, ([message, level]) =>
      Arr.flatMap(Str.split(message, "\n"), (line, index) =>
        edgeWrap(` ${index === 0 ? noticePrefix(level) : ""}${line}`, width),
      ),
    ),
    "",
  ]);
});

/** `/<ext> settings` help, status, errors, and confirmations as notices. */
export const settingsCommandGalleryLines = Effect.fn("settingsCommandGalleryLines")(function* () {
  const lines: string[] = [];
  for (const [name, label, args] of scenarios)
    lines.push(
      ...(yield* noticeFrames(
        `Settings command · /${name} settings ${clipText(args, 48)} · ${label}`,
        (ctx) => commands[name].handler(args, ctx),
      )),
    );
  return lines;
});

/** The real `/activity` registration answering `help` and an unknown subcommand. */
export const activityCommandGalleryLines = Effect.fn("activityCommandGalleryLines")(function* () {
  let handler: RegisteredCommand["handler"] | undefined;
  registerCosmicUiApplication(
    extensionApiFixture({
      registerCommand(name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) {
        if (name === "activity") handler = definition.handler;
      },
    }),
  );
  const lines: string[] = [];
  for (const [label, args] of [
    ["help", "help"],
    ["unknown subcommand", "settings"],
  ] as const)
    lines.push(
      ...(yield* noticeFrames(`Command · /activity ${args} · ${label}`, (ctx) =>
        handler?.(args, ctx),
      )),
    );
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

// The real `/cosmic-ui settings` registration, so the footer item labels show as Pi lists them.
const cosmicUiCompletions = (): RegisteredCommand["getArgumentCompletions"] => {
  let completions: RegisteredCommand["getArgumentCompletions"];
  registerSettingsCommand(
    extensionApiFixture({
      registerCommand(_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) {
        completions = definition.getArgumentCompletions;
      },
    }),
    {
      config: defaultResolvedCosmicUiConfig,
      updateContext: () => undefined,
      update: () => undefined,
      run: () => Promise.resolve(),
      captureAuthority: () => () => true,
    },
  );
  return completions;
};

const completionFrames = (
  title: string,
  items: ReadonlyArray<{ value: string; label: string; description?: string }>,
): string[] =>
  Arr.flatMap([57, 100], (width) => [
    `── Settings autocomplete · ${title}· ${width} cols`,
    ...new SelectList([...items], 10, plainSelectTheme, SLASH_COMMAND_LAYOUT).render(width),
    "",
  ]);

/** `/<ext> settings ` autocomplete, as Pi's editor lists it, in a 57- and a 100-column frame. */
export const settingsCompletionGalleryLines = Effect.fn("settingsCompletionGalleryLines")(
  function* () {
    const demo = Arr.flatMap(completionScenarios, ([name, prefix]) =>
      completionFrames(`/${name} settings ${prefix}`, commands[name].complete?.(prefix) ?? []),
    );
    const complete = cosmicUiCompletions();
    const cosmicUi: string[] = [];
    for (const prefix of ["settings visible:m", "settings visible:s"]) {
      const items = yield* Effect.promise(() => Promise.resolve(complete?.(prefix)));
      cosmicUi.push(...completionFrames(`/cosmic-ui ${prefix} `, items ?? []));
    }
    return [...demo, ...cosmicUi];
  },
);
