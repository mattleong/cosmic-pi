/**
 * One slash command per extension: `/<name>` with subcommands that autocomplete, such as
 * `/openai usage` or `/subagents settings`. Routing and completion are pure; registration is
 * the only host call.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary } from "./host-session.ts";

/** One autocomplete choice; `value` replaces the whole argument text. */
interface CommandCompletion {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface ExtensionSubcommand {
  readonly name: string;
  readonly description: string;
  /** What follows the name in the overview, such as `<prompt>`. */
  readonly arguments?: string | undefined;
  /** Completes the text after `<name> `; values are relative to that text. */
  readonly complete?: ((prefix: string) => ReadonlyArray<CommandCompletion> | null) | undefined;
  readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface ExtensionCommandBare {
  readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  /** Also receives arguments that name no subcommand, such as a prompt. */
  readonly text?: boolean | undefined;
}

interface ExtensionCommandOptions {
  /** The command name without its slash, such as `openai`. */
  readonly name: string;
  readonly description: string;
  /** Runs for a bare `/<name>`; without it, a bare command lists the subcommands. */
  readonly bare?: ExtensionCommandBare | undefined;
  readonly subcommands?: ReadonlyArray<ExtensionSubcommand> | undefined;
}

export interface ExtensionCommand {
  /**
   * Adds a subcommand, or replaces the one with its name in place, so a subcommand that needs
   * a session can arrive when the session starts.
   */
  readonly add: (subcommand: ExtensionSubcommand) => void;
}

type ExtensionCommandRoute =
  | { readonly _tag: "Bare"; readonly args: string }
  | { readonly _tag: "Subcommand"; readonly subcommand: ExtensionSubcommand; readonly args: string }
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Unknown"; readonly name: string };

/** Which part of the command handles `args`. Subcommand names match exactly. */
export const routeExtensionCommand = (
  args: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
  bare?: ExtensionCommandBare,
): ExtensionCommandRoute => {
  const trimmed = args.trim();
  if (!trimmed) return bare ? { _tag: "Bare", args: "" } : { _tag: "Overview" };
  const [head = "", rest = ""] = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed)?.slice(1) ?? [];
  const subcommand = subcommands.find((entry) => entry.name === head);
  if (subcommand) return { _tag: "Subcommand", subcommand, args: rest };
  return bare?.text ? { _tag: "Bare", args: trimmed } : { _tag: "Unknown", name: head };
};

/**
 * Completes subcommand names, then hands the rest to the named subcommand. Returns `null`,
 * never an empty array, when nothing matches, as Pi expects.
 */
export const completeExtensionCommand = (
  prefix: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
): CommandCompletion[] | null => {
  const normalized = prefix.trimStart();
  const split = /^(\S+)\s([\s\S]*)$/u.exec(normalized);
  if (!split) {
    const query = normalized.toLowerCase();
    const matches = subcommands
      .filter((entry) => entry.name.toLowerCase().startsWith(query))
      .map((entry) => ({ value: entry.name, label: entry.name, description: entry.description }));
    return matches.length > 0 ? matches : null;
  }
  const [, head = "", rest = ""] = split;
  const subcommand = subcommands.find((entry) => entry.name === head);
  const inner = subcommand?.complete?.(rest.trimStart());
  if (!inner || inner.length === 0) return null;
  return inner.map((choice) => ({ ...choice, value: `${head} ${choice.value}` }));
};

/** The bare-command overview: each subcommand with its arguments and description. */
const extensionCommandOverview = (
  name: string,
  description: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
): string =>
  [
    `/${name}: ${description}`,
    ...subcommands.map(
      (entry) =>
        `  /${name} ${entry.name}${entry.arguments ? ` ${entry.arguments}` : ""}  ${entry.description}`,
    ),
  ].join("\n");

/** The usage line for arguments that name no subcommand; brackets mark an optional one. */
const extensionCommandUsage = (
  name: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
  bare?: ExtensionCommandBare,
): string => {
  const names = subcommands.map((entry) => entry.name).join("|");
  return `Usage: /${name} ${bare ? `[${names}]` : `<${names}>`}`;
};

/** Runs a handler now, so it can open a view synchronously, and rejects when it throws. */
const settle = (run: () => Promise<void> | void): Promise<void> => {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Registers `/<name>` and returns the handle that adds its subcommands. */
export function registerExtensionCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: ExtensionCommandOptions,
): ExtensionCommand {
  const subcommands = new Map<string, ExtensionSubcommand>();
  for (const subcommand of options.subcommands ?? []) subcommands.set(subcommand.name, subcommand);
  const list = () => [...subcommands.values()];
  const { name, description, bare } = options;
  pi.registerCommand(name, {
    description,
    getArgumentCompletions: (prefix) => completeExtensionCommand(prefix, list()),
    handler: (args, ctx) => {
      const route = routeExtensionCommand(args, list(), bare);
      switch (route._tag) {
        case "Bare":
          return settle(() => bare?.handler(route.args, ctx));
        case "Subcommand":
          return settle(() => route.subcommand.handler(route.args, ctx));
        case "Overview":
          notifyAtHostBoundary(ctx, extensionCommandOverview(name, description, list()), "info");
          return Promise.resolve();
        case "Unknown":
          notifyAtHostBoundary(ctx, extensionCommandUsage(name, list(), bare), "warning");
          return Promise.resolve();
      }
    },
  });
  return { add: (subcommand) => void subcommands.set(subcommand.name, subcommand) };
}
