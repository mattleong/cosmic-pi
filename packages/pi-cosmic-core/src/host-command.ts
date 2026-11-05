import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { notifyAtHostBoundary } from "./host-session.ts";

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

export const completeExtensionCommand = (
  prefix: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
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
  const subcommand = Option.getOrUndefined(
    Arr.findFirst(subcommands, (entry) => entry.name === head),
  );
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
 * The shared overview a bare `/<name>` shows: a title, then one line per subcommand with its
 * description in a padded column. When any line wouldn't fit a phone, every description moves
 * to its own indented line beneath its command instead. `notes` follow as written.
 */
export const extensionCommandOverview = (
  name: string,
  description: string,
  subcommands: ReadonlyArray<ExtensionSubcommandHelp>,
  notes: ReadonlyArray<string> = [],
): string => {
  const usages = Arr.map(
    subcommands,
    (entry) => `/${name} ${entry.name}${entry.arguments ? ` ${entry.arguments}` : ""}`,
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
            `  ${usages[index] ?? ""}`,
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
export const unknownSubcommandText = (name: string, subcommand: string, overview: string): string =>
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

export function registerExtensionCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: ExtensionCommandOptions,
): ExtensionCommand {
  const subcommands = new Map<string, ExtensionSubcommand>();
  for (const subcommand of options.subcommands ?? []) subcommands.set(subcommand.name, subcommand);
  const list = () => [...subcommands.values()];
  const { name, description, bare, overviewNotes } = options;
  pi.registerCommand(name, {
    description,
    getArgumentCompletions: (prefix) => completeExtensionCommand(prefix, list()),
    handler: (args, ctx) => {
      const notify = (message: string, level: "info" | "warning") => {
        notifyAtHostBoundary(ctx, message, level);
        return Promise.resolve();
      };
      const trimmed = Str.trim(args);
      if (!trimmed)
        return bare
          ? settle(() => bare.handler("", ctx))
          : notify(extensionCommandOverview(name, description, list(), overviewNotes), "info");
      const [head = "", rest = ""] = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed)?.slice(1) ?? [];
      const subcommand = subcommands.get(head);
      if (subcommand) return settle(() => subcommand.handler(rest, ctx));
      return bare?.text
        ? settle(() => bare.handler(trimmed, ctx))
        : notify(
            unknownSubcommandText(
              name,
              head,
              extensionCommandOverview(name, description, list(), overviewNotes),
            ),
            "warning",
          );
    },
  });
  return { add: (subcommand) => void subcommands.set(subcommand.name, subcommand) };
}
