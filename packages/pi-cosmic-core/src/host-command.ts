import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
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
}

export interface ExtensionCommand {
  readonly add: (subcommand: ExtensionSubcommand) => void;
}

type ExtensionCommandRoute = Data.TaggedEnum<{
  Bare: { readonly args: string };
  Subcommand: { readonly subcommand: ExtensionSubcommand; readonly args: string };
  Overview: Record<never, never>;
  Unknown: { readonly name: string };
}>;
export const ExtensionCommandRoute = Data.taggedEnum<ExtensionCommandRoute>();

export const routeExtensionCommand = (
  args: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
  bare?: ExtensionCommandBare,
): ExtensionCommandRoute => {
  const trimmed = Str.trim(args);
  if (!trimmed)
    return bare ? ExtensionCommandRoute.Bare({ args: "" }) : ExtensionCommandRoute.Overview();
  const [head = "", rest = ""] = /^(\S+)\s*([\s\S]*)$/u.exec(trimmed)?.slice(1) ?? [];
  const subcommand = Option.getOrUndefined(
    Arr.findFirst(subcommands, (entry) => entry.name === head),
  );
  if (subcommand) return ExtensionCommandRoute.Subcommand({ subcommand, args: rest });
  return bare?.text
    ? ExtensionCommandRoute.Bare({ args: trimmed })
    : ExtensionCommandRoute.Unknown({ name: head });
};

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

const extensionCommandOverview = (
  name: string,
  description: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
): string =>
  Arr.join(
    [
      `/${name}: ${description}`,
      ...Arr.map(
        subcommands,
        (entry) =>
          `  /${name} ${entry.name}${entry.arguments ? ` ${entry.arguments}` : ""}  ${entry.description}`,
      ),
    ],
    "\n",
  );

const extensionCommandUsage = (
  name: string,
  subcommands: ReadonlyArray<ExtensionSubcommand>,
  bare?: ExtensionCommandBare,
): string => {
  const names = Arr.join(
    Arr.map(subcommands, (entry) => entry.name),
    "|",
  );
  return `Usage: /${name} ${bare ? `[${names}]` : `<${names}>`}`;
};

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
  const { name, description, bare } = options;
  pi.registerCommand(name, {
    description,
    getArgumentCompletions: (prefix) => completeExtensionCommand(prefix, list()),
    handler: (args, ctx) => {
      const notify = (message: string, level: "info" | "warning") => {
        notifyAtHostBoundary(ctx, message, level);
        return Promise.resolve();
      };
      return ExtensionCommandRoute.$match(routeExtensionCommand(args, list(), bare), {
        Bare: (route) => settle(() => bare?.handler(route.args, ctx)),
        Subcommand: (route) => settle(() => route.subcommand.handler(route.args, ctx)),
        Overview: () => notify(extensionCommandOverview(name, description, list()), "info"),
        Unknown: () => notify(extensionCommandUsage(name, list(), bare), "warning"),
      });
    },
  });
  return { add: (subcommand) => void subcommands.set(subcommand.name, subcommand) };
}
