import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clipText, countLabel } from "pi-cosmic-core/display";
import { notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { extensionCommandOverview, registerExtensionCommand } from "pi-cosmic-core/host-command";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { directoryName, distinctSessionLabels, SESSION_STATE_LABELS } from "./identity.ts";
import type { ListedSession, SessionListContract } from "./tools/contract.ts";

export const INTERCOM_COMMAND = "intercom";
const DESCRIPTION = "Message your other live Pi sessions";
const UNAVAILABLE = "Intercom isn't running in this session";

export interface IntercomCommandHost {
  /** Whether this session is registered and reachable. */
  readonly isActive: () => boolean;
  readonly list: (signal?: AbortSignal) => Promise<SessionListContract>;
  readonly receiving: () => boolean;
  readonly setReceiving: (receiving: boolean) => void;
}

// Notifications wrap at the terminal edge without a hanging indent, so each line stays short
// enough for a narrow pane: an indented label and state, and a two-line hint.
const listedLine = (session: ListedSession, label: string): string => {
  const directory = directoryName(session.cwd);
  const named = session.name !== undefined && Str.isNonEmpty(Str.trim(session.name));
  return Arr.join(
    [
      `  ${label}`,
      SESSION_STATE_LABELS[session.state],
      ...(named && directory !== "" ? [`in ${directory}`] : []),
      ...(session.duplicate ? ["duplicate id"] : []),
    ],
    " · ",
  );
};

const EXAMPLE_LABEL_CHARS = 20;

const howToMessage = (example: string | undefined): ReadonlyArray<string> => [
  "To message one, ask your agent, for example:",
  `  "Ask the ${example === undefined ? "web" : clipText(example, EXAMPLE_LABEL_CHARS)} session to rerun its tests"`,
];

const reachable = (session: ListedSession): boolean =>
  session.state === "idle" || session.state === "busy";

export const listReport = (result: SessionListContract): string => {
  const total = result.sessions.length + result.omitted;
  if (total === 0) return "No other live Pi sessions";
  const labels = distinctSessionLabels(result.sessions);
  const example = Arr.findFirstIndex(result.sessions, reachable);
  return Arr.join(
    [
      countLabel(total, "other live session"),
      ...Arr.map(result.sessions, (session, index) => listedLine(session, labels[index] ?? "")),
      ...(result.omitted > 0 ? [`  and ${result.omitted} more`] : []),
      ...howToMessage(Option.isSome(example) ? labels[example.value] : labels[0]),
    ],
    "\n",
  );
};

const receivingReport = (receiving: boolean): string =>
  receiving
    ? "Other sessions can message this session"
    : "Messages from other sessions are turned off for this session";

const RECEIVE_CHOICES = ["on", "off"] as const;

/** `/intercom list` and `/intercom receive [on|off]`; receiving resets to on with each session. */
const notify = (ctx: ExtensionCommandContext, message: string, level: "info" | "warning") =>
  notifyAtHostBoundary(ctx, message, level);

const LIST_HELP = { name: "list", description: "List other live sessions" } as const;
const RECEIVE_HELP = {
  name: "receive",
  arguments: "[on|off]",
  description: "Allow or block messages",
} as const;
const HOW_TO_MESSAGE = howToMessage(undefined);

/** The shared command overview, plus how to message a session. */
export const overview = extensionCommandOverview(
  INTERCOM_COMMAND,
  DESCRIPTION,
  [LIST_HELP, RECEIVE_HELP],
  HOW_TO_MESSAGE,
);

export function registerIntercomCommand(pi: ExtensionAPI, host: IntercomCommandHost): void {
  registerExtensionCommand(pi, {
    name: INTERCOM_COMMAND,
    description: DESCRIPTION,
    overviewNotes: HOW_TO_MESSAGE,
    subcommands: [
      {
        ...LIST_HELP,
        handler: (_args, ctx) => {
          if (!host.isActive()) return notify(ctx, UNAVAILABLE, "warning");
          return host.list(ctx.signal).then(
            (result) => notify(ctx, listReport(result), "info"),
            () => notify(ctx, "Couldn't list your other sessions", "warning"),
          );
        },
      },
      {
        ...RECEIVE_HELP,
        complete: (prefix) =>
          Arr.flatMap(RECEIVE_CHOICES, (choice) =>
            Fn.pipe(choice, Str.startsWith(Str.trim(prefix)))
              ? [{ value: choice, label: choice }]
              : [],
          ),
        handler: (args, ctx) => {
          if (!host.isActive()) return notify(ctx, UNAVAILABLE, "warning");
          const choice = Str.trim(args);
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
