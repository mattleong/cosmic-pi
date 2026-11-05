import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { endElide } from "pi-code-previews";
import { countLabel } from "pi-cosmic-core/display";
import { notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { registerExtensionCommand } from "pi-cosmic-core/host-command";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  distinctSessionLabels,
  SESSION_STATE_GLYPHS,
  SESSION_STATE_LABELS,
  shortDisplayDirectory,
} from "./identity.ts";
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
// enough for a narrow pane: an indented status glyph, label, and state, as session_list shows
// them, a named session's `~` directory on its own line beneath, its middle elided when long, and
// a two-line hint.
const listedLines = (session: ListedSession, label: string): ReadonlyArray<string> => {
  const directory = shortDisplayDirectory(session.cwd);
  const named = session.name !== undefined && Str.isNonEmpty(Str.trim(session.name));
  return [
    Arr.join(
      [
        `  ${SESSION_STATE_GLYPHS[session.state]} ${label}`,
        SESSION_STATE_LABELS[session.state],
        ...(session.duplicate ? ["duplicate id"] : []),
      ],
      " · ",
    ),
    ...(named && directory !== "" ? [`    ${directory}`] : []),
  ];
};

// A notice can't know its width, so a long session name ends at a word boundary in its list.
const NOTICE_LABEL_CHARS = 40;

// Keeps the example on one 55-column notice line; a longer label ends at a word boundary.
const EXAMPLE_LABEL_CHARS = 18;

const howToMessage = (example: string | undefined): ReadonlyArray<string> => [
  "To message one, ask your agent, for example:",
  `  "Ask the ${example === undefined ? "web" : endElide(example, EXAMPLE_LABEL_CHARS)} session to run its tests"`,
];

const reachable = (session: ListedSession): boolean =>
  session.state === "idle" || session.state === "busy";

export const listReport = (result: SessionListContract): string => {
  const total = result.sessions.length + result.omitted;
  if (total === 0) return "No other live Pi sessions";
  const labels = distinctSessionLabels(result.sessions, NOTICE_LABEL_CHARS);
  const example = Arr.findFirstIndex(result.sessions, reachable);
  return Arr.join(
    [
      countLabel(total, "other live session"),
      ...Arr.flatMap(result.sessions, (session, index) =>
        listedLines(session, labels[index] ?? ""),
      ),
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

const HOW_TO_MESSAGE = howToMessage(undefined);

export function registerIntercomCommand(pi: ExtensionAPI, host: IntercomCommandHost): void {
  registerExtensionCommand(pi, {
    name: INTERCOM_COMMAND,
    description: DESCRIPTION,
    overviewNotes: HOW_TO_MESSAGE,
    subcommands: [
      {
        name: "list",
        description: "List live sessions",
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
        description: "Messages on or off",
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
