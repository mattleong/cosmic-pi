import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  countLabel,
  notifyAtHostBoundary,
  registerExtensionCommand,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import type { ListedSession, SessionListContract } from "./tools/contract.ts";
import { sessionSubject } from "./tools/summary.ts";

export const INTERCOM_COMMAND = "intercom";
const UNAVAILABLE = "Intercom isn't running in this session";

export interface IntercomCommandHost {
  /** Whether this session is registered and reachable. */
  readonly isActive: () => boolean;
  readonly list: (signal?: AbortSignal) => Promise<SessionListContract>;
  readonly receiving: () => boolean;
  readonly setReceiving: (receiving: boolean) => void;
}

const STATE_LABELS: Record<ListedSession["state"], string> = {
  idle: "idle",
  busy: "busy",
  unresponsive: "not answering",
};

const listedLine = (session: ListedSession): string =>
  [
    `- ${sessionSubject(session)} in ${sanitizeTerminalLine(session.cwd)}: ${STATE_LABELS[session.state]}`,
    session.duplicate ? " (shares its id with another session)" : "",
  ].join("");

const listReport = (result: SessionListContract): string => {
  const total = result.sessions.length + result.omitted;
  if (total === 0) return "No other live Pi sessions";
  return [
    `${countLabel(total, "other live session")}:`,
    ...result.sessions.map(listedLine),
    ...(result.omitted > 0 ? [`- and ${result.omitted} more`] : []),
  ].join("\n");
};

const receivingReport = (receiving: boolean): string =>
  receiving
    ? "Other sessions can message this session"
    : "Messages from other sessions are turned off for this session";

const RECEIVE_CHOICES = ["on", "off"] as const;

/** `/intercom list` and `/intercom receive [on|off]`; receiving resets to on with each session. */
const notify = (ctx: ExtensionCommandContext, message: string, level: "info" | "warning") =>
  notifyAtHostBoundary(ctx, message, level);

export function registerIntercomCommand(pi: ExtensionAPI, host: IntercomCommandHost): void {
  registerExtensionCommand(pi, {
    name: INTERCOM_COMMAND,
    description: "Reach your other live Pi sessions on this machine",
    subcommands: [
      {
        name: "list",
        description: "List your other live sessions",
        handler: (_args, ctx) => {
          if (!host.isActive()) return notify(ctx, UNAVAILABLE, "warning");
          return host.list(ctx.signal).then(
            (result) => notify(ctx, listReport(result), "info"),
            () => notify(ctx, "Couldn't list your other sessions", "warning"),
          );
        },
      },
      {
        name: "receive",
        arguments: "[on|off]",
        description: "Show or set whether other sessions can message this one",
        complete: (prefix) =>
          RECEIVE_CHOICES.flatMap((choice) =>
            choice.startsWith(prefix.trim()) ? [{ value: choice, label: choice }] : [],
          ),
        handler: (args, ctx) => {
          if (!host.isActive()) return notify(ctx, UNAVAILABLE, "warning");
          const choice = args.trim();
          if (choice === "") return notify(ctx, receivingReport(host.receiving()), "info");
          if (choice !== "on" && choice !== "off")
            return notify(ctx, "Usage: /intercom receive [on|off]", "warning");
          host.setReceiving(choice === "on");
          return notify(ctx, receivingReport(choice === "on"), "info");
        },
      },
    ],
  });
}
