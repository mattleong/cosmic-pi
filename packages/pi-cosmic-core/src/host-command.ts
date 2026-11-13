import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { notifyAtHostBoundary } from "./host-session.ts";
import { findOrUndefined } from "./array.ts";

interface CommandCompletion {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ExtensionSubcommand {
  readonly name: string;
  readonly description: string;
  readonly arguments?: string | undefined;
  readonly complete?: ((prefix: string) => ReadonlyArray<CommandCompletion> | null) | undefined;
  readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface ExtensionCommandBare {
  readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  readonly text?: boolean | undefined;
  /** What bare `/<name>` does, listed first in the overview, such as "Open background tasks". */
  readonly description?: string | undefined;
  /** What bare `/<name>` accepts, listed beside it in the overview, such as `[question]`. */
  readonly arguments?: string | undefined;
}

interface ExtensionCommandOptions {
  readonly name: string;
  readonly description: string;
  readonly bare?: ExtensionCommandBare | undefined;
  readonly subcommands?: ReadonlyArray<ExtensionSubcommand> | undefined;
  /** Lines after the subcommands in the bare overview, such as an example. */
  readonly overviewNotes?: ReadonlyArray<string> | undefined;
}

export interface ExtensionCommand {
  readonly add: (subcommand: ExtensionSubcommand) => void;
}

const completeExtensionCommand = (
  prefix: string,
  subcommands: ReadonlyArray<Pick<ExtensionSubcommand, "name" | "description" | "complete">>,
): CommandCompletion[] | null => {
  const normalized = Str.trimStart(prefix);
  const split = /^(\S+)\s([\s\S]*)$/u.exec(normalized);
  if (!split) {
    const query = Str.toLowerCase(normalized);
    const matches = Arr.flatMap(subcommands, (entry) =>
      Fn.pipe(entry.name, Str.toLowerCase, Str.startsWith(query))
        ? [{ value: entry.name, label: entry.name, description: entry.description }]
        : [],
    );
    return matches.length > 0 ? matches : null;
  }
  const [, head = "", rest = ""] = split;
  const subcommand = findOrUndefined(subcommands, (entry) => entry.name === head);
  const inner = subcommand?.complete?.(Str.trimStart(rest));
  if (!inner || inner.length === 0) return null;
  return Arr.map(inner, (choice) =>
    Object.assign({}, choice, { value: `${head} ${choice.value}` }),
  );
};

/** The part of a subcommand its overview line shows. */
export type ExtensionSubcommandHelp = Pick<
  ExtensionSubcommand,
  "name" | "arguments" | "description"
>;

// Notifications wrap at the terminal edge without a hanging indent and draw one column in, so the
// overview keeps every line short enough for a 57-column phone client.
const OVERVIEW_COLUMNS = 55;

/** Wraps between words, indenting continuation rows; a single overlong word keeps its own row. */
const wrapWords = (text: string, first: string, rest: string): string[] =>
  Arr.reduce(Str.split(Str.trim(text), /\s+/u), [first], (rows, word) => {
    const last = Option.getOrElse(Arr.last(rows), () => "");
    const blank = last === first || last === rest;
    const joined = blank ? `${last}${word}` : `${last} ${word}`;
    return joined.length <= OVERVIEW_COLUMNS || blank
      ? [...rows.slice(0, -1), joined]
      : [...rows, `${rest}${word}`];
  });

/**
 * The shared overview `/<name> help` shows: a title, then one line per subcommand with its
 * description in a padded column; an entry with an empty name stands for bare `/<name>`. When any
 * line wouldn't fit a phone, every description moves to its own line beneath its command, indented
 * four columns, and a command too wide for a row wraps six columns in, past the description's
 * column. `notes` follow as written.
 */
export const extensionCommandOverview = (
  name: string,
  description: string,
  subcommands: ReadonlyArray<ExtensionSubcommandHelp>,
  notes: ReadonlyArray<string> = [],
): string => {
  const usages = Arr.map(subcommands, (entry) =>
    Arr.join(
      Arr.filter([`/${name}`, entry.name, entry.arguments ?? ""], (part) => part !== ""),
      " ",
    ),
  );
  const column = Math.max(0, ...Arr.map(usages, (usage) => usage.length));
  const aligned = Arr.map(
    subcommands,
    (entry, index) => `  ${Fn.pipe(usages[index] ?? "", Str.padEnd(column))}  ${entry.description}`,
  );
  const fits = Arr.every(aligned, (line) => line.length <= OVERVIEW_COLUMNS);
  return Arr.join(
    [
      ...wrapWords(`/${name}: ${description}`, "", "  "),
      ...(fits
        ? aligned
        : Arr.flatMap(subcommands, (entry, index) => [
            // A wrapped usage hangs past the description's column, so it never reads as description.
            ...wrapWords(usages[index] ?? "", "  ", "      "),
            ...wrapWords(entry.description, "    ", "    "),
          ])),
      ...notes,
    ],
    "\n",
  );
};

// Leaves room for the longest command name on a 55-column notice line.
const UNKNOWN_SUBCOMMAND_COLUMNS = 24;

/** What an unrecognized subcommand shows: which word wasn't known, then the overview. */
const unknownSubcommandText = (name: string, subcommand: string, overview: string): string =>
  `Unknown /${name} command: ${clipText(subcommand, UNKNOWN_SUBCOMMAND_COLUMNS)}\n${overview}`;

const settle = (run: () => Promise<void> | void): Promise<void> => {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(
      Predicate.isError(error) ? error : new Error("The command failed.", { cause: error }),
    );
  }
};

/** The subcommand every registered command has unless it declares its own `help`. */
const HELP_SUBCOMMAND = { name: "help", description: "Show this help" } as const;

export function registerExtensionCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: ExtensionCommandOptions,
): ExtensionCommand {
  const subcommands = new Map<string, ExtensionSubcommand>();
  for (const subcommand of options.subcommands ?? []) subcommands.set(subcommand.name, subcommand);
  const list = () => [...subcommands.values()];
  const { name, description, bare, overviewNotes } = options;
  const withHelp = () => [
    ...list(),
    ...(subcommands.has(HELP_SUBCOMMAND.name) ? [] : [HELP_SUBCOMMAND]),
  ];
  const overview = () =>
    extensionCommandOverview(
      name,
      description,
      [
        ...(bare?.description
          ? [{ name: "", description: bare.description, arguments: bare.arguments }]
          : []),
        ...withHelp(),
      ],
      overviewNotes,
    );
  pi.registerCommand(name, {
    description,
    getArgumentCompletions: (prefix) => completeExtensionCommand(prefix, withHelp()),
    handler: (args, ctx) => {
      const notify = (message: string, level: "info" | "warning") => {
        notifyAtHostBoundary(ctx, message, level);
        return Promise.resolve();
      };
      const trimmed = Str.trim(args);
      if (!trimmed) return bare ? settle(() => bare.handler("", ctx)) : notify(overview(), "info");
      const [head = "", rest = ""] = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed)?.slice(1) ?? [];
      const subcommand = subcommands.get(head);
      if (subcommand) return settle(() => subcommand.handler(rest, ctx));
      // A free-text command keeps `help me debug X` as its text; only a lone `help` asks for the overview.
      if (head === HELP_SUBCOMMAND.name && !(bare?.text && rest)) return notify(overview(), "info");
      return bare?.text
        ? settle(() => bare.handler(trimmed, ctx))
        : notify(unknownSubcommandText(name, head, overview()), "warning");
    },
  });
  return { add: (subcommand) => void subcommands.set(subcommand.name, subcommand) };
}
