import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { clipText } from "pi-cosmic-core/display";
import { nodeDisplayHomeDirectory } from "pi-cosmic-core/platform/node-builtins";
import { abbreviateHomePath } from "pi-cosmic-core/platform/paths";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
import type { ListedSession, SessionView } from "./tools/contract.ts";

/** Longest session name or directory a heading or list row shows before clipping with `…`. */
const MAX_SUBJECT_CHARS = 40;
/** Characters of a session id a short id starts with; colliding labels lengthen it. */
const SHORT_ID_CHARS = 4;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The words a person reads for each listed state. */
export const SESSION_STATE_LABELS: Record<ListedSession["state"], string> = {
  idle: "idle",
  busy: "busy",
  unavailable: "unavailable",
  unresponsive: "not answering",
  unreachable: "unreachable",
};

/**
 * Each listed state's status glyph: idle is done with its turn, busy was working when the list was
 * taken, unavailable and not answering couldn't confirm their state, and unreachable failed.
 */
export const SESSION_STATE_GLYPHS = {
  idle: SUITE_STATUS_GLYPHS.succeeded,
  busy: SUITE_STATUS_GLYPHS.neutral,
  unavailable: SUITE_STATUS_GLYPHS.uncertain,
  unresponsive: SUITE_STATUS_GLYPHS.uncertain,
  unreachable: SUITE_STATUS_GLYPHS.failed,
} as const satisfies Record<ListedSession["state"], string>;

type SessionIdentity = Pick<SessionView, "sessionId" | "name" | "cwd">;

/** The last component of a working directory, such as `web` for `/Users/me/web`. */
const directoryName = (cwd: string): string => {
  const clean = sanitizeTerminalLine(cwd);
  if (clean === "") return "";
  return Arr.lastNonEmpty(Fn.pipe(clean, Str.replaceAll(/\/+$/gu, ""), Str.split("/"))) || "/";
};

/** A working directory as people read it, with the home directory shortened to `~`: `~/web`. */
export const displayDirectory = (cwd: string): string =>
  abbreviateHomePath(sanitizeTerminalLine(cwd), nodeDisplayHomeDirectory());

/** Longest directory a short line shows before its middle components elide. */
const MAX_DIRECTORY_CHARS = 40;

/**
 * A directory for a short line: {@link displayDirectory}'s form, with middle components elided
 * when it is long, `~/…/platform/web-frontend`, so it keeps its root and the components that name it.
 */
export const shortDisplayDirectory = (cwd: string): string => {
  const directory = displayDirectory(cwd);
  if (directory.length <= MAX_DIRECTORY_CHARS) return directory;
  const [root, ...rest] = Str.split(directory, "/");
  const components = Arr.filter(rest, Str.isNonEmpty);
  let kept = Arr.empty<string>();
  for (const component of Arr.reverse(components)) {
    const candidate = [component, ...kept];
    if (kept.length > 0 && `${root}/…/${Arr.join(candidate, "/")}`.length > MAX_DIRECTORY_CHARS)
      break;
    kept = candidate;
  }
  return kept.length === components.length
    ? directory
    : `${root}/…/${clipText(Arr.join(kept, "/"), MAX_DIRECTORY_CHARS)}`;
};

const idCharacters = (sessionId: string): string =>
  Fn.pipe(sanitizeTerminalLine(sessionId), Str.replaceAll(/[^0-9A-Za-z]/gu, ""));

/** The end of a session id, where UUIDv7's random bits make ids differ: `#9038`. */
export const shortSessionId = (sessionId: string, length = SHORT_ID_CHARS): string => {
  const characters = idCharacters(sessionId);
  return `#${Fn.pipe(characters, Str.slice(Math.max(0, characters.length - length)))}`;
};

/** How a heading names a session: its name, else its directory, else a short id. */
export const sessionSubject = (session: SessionIdentity): string => {
  const name = sanitizeTerminalLine(session.name ?? "");
  if (name !== "") return clipText(name, MAX_SUBJECT_CHARS);
  const directory = directoryName(session.cwd);
  return directory === ""
    ? shortSessionId(session.sessionId)
    : clipText(directory, MAX_SUBJECT_CHARS);
};

/** A session's whole name when {@link sessionSubject} clipped it, so expansion can show it. */
export const clippedSessionName = (session: {
  readonly name?: string | undefined;
}): string | undefined => {
  const name = sanitizeTerminalLine(session.name ?? "");
  return name.length > MAX_SUBJECT_CHARS ? name : undefined;
};

/** How a heading names an addressee before a session answers: full ids shorten to `#9038`. */
export const addresseeSubject = (to: string | undefined): string => {
  const target = sanitizeTerminalLine(to ?? "");
  return SESSION_ID_PATTERN.test(target)
    ? `session ${shortSessionId(target)}`
    : clipText(target, MAX_SUBJECT_CHARS);
};

/** The most sessions {@link SessionNames} remembers; the oldest is forgotten first. */
const MAX_REMEMBERED_SESSIONS = 256;

/**
 * Sessions this runtime's tools have already seen, so a call can name its addressee while it runs
 * instead of showing its id. Results feed it; renderers only read it.
 */
export interface SessionNames {
  readonly remember: (sessions: ReadonlyArray<SessionIdentity>) => void;
  readonly lookup: (sessionId: string) => SessionIdentity | undefined;
}

export const sessionNameCache = (): SessionNames => {
  const known = new Map<string, SessionIdentity>();
  return {
    remember: (sessions) => {
      for (const session of sessions) {
        known.delete(session.sessionId);
        known.set(session.sessionId, session);
      }
      for (const id of known.keys()) {
        if (known.size <= MAX_REMEMBERED_SESSIONS) break;
        known.delete(id);
      }
    },
    lookup: (sessionId) => known.get(sessionId),
  };
};

/** How a heading names an addressee before a result does: by name when it is known. */
export const knownAddresseeSubject = (
  to: string | undefined,
  names: SessionNames | undefined,
): string => {
  const known = to === undefined ? undefined : names?.lookup(to);
  return known === undefined ? addresseeSubject(to) : sessionSubject(known);
};

const uniqueSuffixLength = (ids: ReadonlyArray<string>): number => {
  const longest = Math.max(SHORT_ID_CHARS, ...Arr.map(ids, (id) => idCharacters(id).length));
  for (let length = SHORT_ID_CHARS; length < longest; length++)
    if (new Set(Arr.map(ids, (id) => shortSessionId(id, length))).size === ids.length)
      return length;
  return longest;
};

/**
 * Labels for sessions listed together: each one's {@link sessionSubject}, with a short id appended
 * only where two subjects match, long enough to tell those sessions apart.
 */
export const distinctSessionLabels = (
  sessions: ReadonlyArray<SessionIdentity>,
): ReadonlyArray<string> => {
  const entries = Arr.map(sessions, (session) => ({
    id: session.sessionId,
    subject: sessionSubject(session),
  }));
  const groups = Arr.groupBy(entries, (entry) => Str.toLowerCase(entry.subject));
  return Arr.map(entries, ({ id, subject }) => {
    const ids = Arr.map(groups[Str.toLowerCase(subject)] ?? [], (entry) => entry.id);
    return ids.length < 2 ? subject : `${subject} ${shortSessionId(id, uniqueSuffixLength(ids))}`;
  });
};
