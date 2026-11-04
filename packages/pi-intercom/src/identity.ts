import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { clipText } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
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

type SessionIdentity = Pick<SessionView, "sessionId" | "name" | "cwd">;

/** The last component of a working directory, such as `web` for `/Users/me/web`. */
export const directoryName = (cwd: string): string => {
  const clean = sanitizeTerminalLine(cwd);
  if (clean === "") return "";
  return Arr.lastNonEmpty(Fn.pipe(clean, Str.replaceAll(/\/+$/gu, ""), Str.split("/"))) || "/";
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

/** How a heading names an addressee before a session answers: full ids shorten to `#9038`. */
export const addresseeSubject = (to: string | undefined): string => {
  const target = sanitizeTerminalLine(to ?? "");
  return SESSION_ID_PATTERN.test(target)
    ? `session ${shortSessionId(target)}`
    : clipText(target, MAX_SUBJECT_CHARS);
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
