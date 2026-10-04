// Pi command handlers are Promise-shaped host boundaries.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  clipText,
  countLabel,
  failureMessage,
  notifyAtHostBoundary,
  registerExtensionCommand,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import type { SubagentFeatureSource } from "../config/schema.ts";
import type { WorkflowListing } from "../workflow/store.ts";
import { parseUltracodeRequest, type UltracodeRequest } from "./request.ts";

/** What bare `/ultracode` reports. */
export interface UltracodeStatus {
  readonly enabled: boolean;
  readonly source: SubagentFeatureSource;
  /** Whether the window is open, and how many workflow runs still need the main agent. */
  readonly window: { readonly open: boolean; readonly runs: number };
  readonly saved: WorkflowListing;
}

export interface UltracodeCommandHost {
  readonly isAvailable: () => boolean;
  readonly status: () => Promise<UltracodeStatus>;
  /** Sets ultracode for this session, over any saved value. */
  readonly setSession: (enabled: boolean) => Promise<void>;
  /** Opens the one-off window and sends the request to the main agent. */
  readonly send: (ctx: ExtensionCommandContext, request: UltracodeRequest) => Promise<void>;
}

const UNAVAILABLE = "Ultracode isn't available in this session";
const USAGE = "Usage: /ultracode [on|off] or /ultracode [+500k] <task>";
const SAVED_LISTED = 12;

const SOURCES = {
  default: "default",
  global: "global setting",
  project: "project setting",
  session: "session setting",
} as const satisfies Record<SubagentFeatureSource, string>;

const savedLines = (listing: WorkflowListing): string[] => {
  if (listing.workflows.length === 0) return ["Saved workflows: none"];
  const shown = listing.workflows.slice(0, SAVED_LISTED).map(
    // The description is the workflow author's text, clipped to one short line.
    ({ name, scope, meta }) => `  ${name} (${scope}): ${clipText(meta.description, 80)}`,
  );
  const more = listing.workflows.length - shown.length;
  const rest = more > 0 ? [`  …and ${more} more`] : listing.truncated ? ["  …and more"] : [];
  return ["Saved workflows:", ...shown, ...rest];
};

/**
 * The one-off window while the setting is off. Every workflow run keeps the window open, so
 * with the setting on only the runs are reported: no one-off request opened anything.
 */
const windowLines = (status: UltracodeStatus): string[] => {
  const runs = status.window.runs;
  if (status.enabled) return runs > 0 ? [`Workflow runs awaiting the main agent: ${runs}`] : [];
  if (!status.window.open) return ["One-off window: closed"];
  return [`One-off window: open${runs > 0 ? ` · ${countLabel(runs, "workflow run")}` : ""}`];
};

/** The bare command's report: the setting, the one-off window, saved workflows and usage. */
export const ultracodeStatusText = (status: UltracodeStatus): string =>
  [
    `Ultracode: ${status.enabled ? "on" : "off"} (${SOURCES[status.source]})`,
    ...windowLines(status),
    ...savedLines(status.saved),
    "Usage:",
    "  /ultracode on|off  Turn ultracode on or off for this session",
    "  /ultracode [+500k] <task>  Run one request as a workflow, with an optional token budget",
    "  /subagents settings  Save ultracode for new sessions (global or project)",
  ].join("\n");

type Toggle = "on" | "off";

/** Turns ultracode on or off for the session. */
const toggle = (
  host: UltracodeCommandHost,
  name: Toggle,
  ctx: ExtensionCommandContext,
): Promise<void> | void => {
  if (!host.isAvailable()) return notifyAtHostBoundary(ctx, UNAVAILABLE, "warning");
  return host.setSession(name === "on").then(
    () =>
      notifyAtHostBoundary(
        ctx,
        `Turned ultracode ${name} for this session; /subagents settings saves it for new sessions`,
        "info",
      ),
    (error) =>
      notifyAtHostBoundary(
        ctx,
        `Couldn't turn ultracode ${name}: ${failureMessage(
          error instanceof Error ? error.message : "",
          "unknown error",
        )}`,
        "error",
      ),
  );
};

/** `on` or `off`; other words after the name are a task. */
const toggleSubcommand = (
  host: UltracodeCommandHost,
  name: Toggle,
  sendTask: (ctx: ExtensionCommandContext, args: string) => Promise<void> | void,
): ExtensionSubcommand => ({
  name,
  description: `Turn ultracode ${name} for this session`,
  handler: (args, ctx) =>
    args.trim() ? sendTask(ctx, `${name} ${args}`) : toggle(host, name, ctx),
});

/**
 * `/ultracode`: bare it reports the setting and the one-off window, `on` and `off` set it for the
 * session, and any other text is a task to run as a workflow once, like Claude Code's ultracode.
 * A lone word that reads as a command, such as `On`, `help` or `status`, never becomes a task,
 * since a mistyped switch would otherwise start a multi-agent workflow.
 */
export function registerUltracodeCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  host: UltracodeCommandHost,
): void {
  const sendTask = (ctx: ExtensionCommandContext, args: string): Promise<void> | void => {
    if (!host.isAvailable()) return notifyAtHostBoundary(ctx, UNAVAILABLE, "warning");
    const request = parseUltracodeRequest(args);
    if (!request.task) return notifyAtHostBoundary(ctx, USAGE, "warning");
    return host
      .send(ctx, request)
      .catch(() => notifyAtHostBoundary(ctx, "Couldn't send the request", "error"));
  };
  const report = (ctx: ExtensionCommandContext): Promise<void> | void => {
    if (!host.isAvailable()) return notifyAtHostBoundary(ctx, UNAVAILABLE, "warning");
    return host.status().then(
      (status) => notifyAtHostBoundary(ctx, ultracodeStatusText(status), "info"),
      () => notifyAtHostBoundary(ctx, UNAVAILABLE, "warning"),
    );
  };
  registerExtensionCommand(pi, {
    name: "ultracode",
    description: "Opt into multi-agent workflows, or run one request as a workflow",
    bare: {
      text: true,
      handler: (args, ctx) => {
        const word = args.trim().toLowerCase();
        if (word === "" || word === "help" || word === "status") return report(ctx);
        if (word === "on" || word === "off") return toggle(host, word, ctx);
        return sendTask(ctx, args);
      },
    },
    subcommands: [toggleSubcommand(host, "on", sendTask), toggleSubcommand(host, "off", sendTask)],
  });
}
