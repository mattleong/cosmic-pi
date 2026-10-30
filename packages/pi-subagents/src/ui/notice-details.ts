import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipText } from "pi-cosmic-core/display";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";

/** Bounds the display copy of one agent's words in a notice; the model's content keeps its own. */
export const MAX_NOTICE_TEXT_CHARS = 16 * 1024;
/** Bounds all display copies of one completion notice together. */
export const MAX_NOTICE_TOTAL_TEXT_CHARS = 32 * 1024;
export const MAX_NOTICE_FACTS = 8;
export const MAX_NOTICE_FACT_CHARS = 512;
export const MAX_NOTICE_RUNS = 12;
export const MAX_STOPPED_NOTICE_RUNS = 20;
const MAX_NOTICE_NAME_CHARS = 120;

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(100_000));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTICE_NAME_CHARS));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTICE_TEXT_CHARS));
const Fact = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTICE_FACT_CHARS));
const Facts = Schema.Array(Fact).check(Schema.isMaxLength(MAX_NOTICE_FACTS));

/** A finished run as a notice shows it: its words, short status notes, and technical facts. */
const NoticeRun = Schema.Struct({
  id: Id,
  name: Name,
  outcome: Schema.Literals(["completed", "failed"]),
  /** The report, or the failure; a display copy bounded with the notice. */
  text: Schema.optionalKey(Text),
  /** `text` is only the start of the run's words. */
  textCut: Schema.optionalKey(Schema.Literal(true)),
  /** Short human status such as a warning or a worktree proposal. */
  notes: Schema.optionalKey(Facts),
  /** Technical facts for the expanded view: ID, profile, files, routes. */
  facts: Schema.optionalKey(Facts),
});
export type NoticeRun = typeof NoticeRun.Type;

const StoppedRun = Schema.Struct({ id: Id, name: Name, state: Name });

export const MAX_NOTICE_PEERS = 20;

/** A nested run's notice of the active peers sharing its working directory. */
const PeerNoticeDetailsSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("peers"),
  /** The receiving run's own role, such as `read-only`. */
  ownership: Schema.optionalKey(Name),
  peers: Schema.Array(
    Schema.Struct({
      id: Id,
      name: Name,
      ownership: Name,
      state: Name,
      task: Schema.optionalKey(Fact),
    }),
  ).check(Schema.isMaxLength(MAX_NOTICE_PEERS)),
  total: Count,
});
export type PeerNoticeDetails = typeof PeerNoticeDetailsSchema.Type;

/** Display receipts of the root's completion, question, and stopped-runs notices. */
export const NoticeDetailsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("question"),
    id: Schema.optionalKey(Id),
    name: Schema.optionalKey(Name),
    question: Schema.optionalKey(Text),
    questionCut: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("completed"),
    ids: Schema.optionalKey(Schema.Array(Id)),
    total: Count,
    failed: Count,
    warnings: Count,
    name: Schema.optionalKey(Name),
    runs: Schema.optionalKey(Schema.Array(NoticeRun).check(Schema.isMaxLength(MAX_NOTICE_RUNS))),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("stopped"),
    total: Count,
    name: Schema.optionalKey(Name),
    cause: Schema.optionalKey(Schema.Literals(["reload", "session"])),
    runs: Schema.optionalKey(
      Schema.Array(StoppedRun).check(Schema.isMaxLength(MAX_STOPPED_NOTICE_RUNS)),
    ),
  }),
  PeerNoticeDetailsSchema,
]);
export type NoticeDetails = typeof NoticeDetailsSchema.Type;

/** A display name, one line and bounded. */
export const noticeName = (name: string): string =>
  clipText(sanitizeTerminalLine(name), 60) || "subagent";

/** A short display fact or note, one line and bounded. */
export const noticeFact = (fact: string): string =>
  clipText(sanitizeTerminalLine(fact), MAX_NOTICE_FACT_CHARS);

/**
 * A bounded display copy of words an agent wrote, keeping its line breaks. Undefined for blank
 * text; `cut` when the copy is shorter than the words.
 */
export const noticeText = (
  text: string | undefined,
  limit = MAX_NOTICE_TEXT_CHARS,
): { readonly text: string; readonly cut: boolean } | undefined => {
  const cleaned = Str.trim(stripTerminalControls(text ?? ""));
  if (!cleaned) return undefined;
  const bounded = clipText(cleaned, Math.min(limit, MAX_NOTICE_TEXT_CHARS));
  return { text: bounded, cut: bounded !== cleaned };
};
