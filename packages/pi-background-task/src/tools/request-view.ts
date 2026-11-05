import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  expandedArguments,
  expandedDetails,
  expandedFields,
  type ExpandedField,
} from "pi-code-previews";
import { formatDuration } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { BackgroundTaskToolInput } from "./schema.ts";

/** One labeled request fact; a multi-line command keeps its line breaks. */
export type LabeledRow = ExpandedField;

const NOTIFY_LABELS = {
  exit: "when it finishes",
  failure: "if it fails or times out",
} as const;

// Renderers receive raw arguments: blanks and nulls mean absent, and numbers may still be strings
// that Pi's validation would coerce.
const Text = Schema.optionalKey(Schema.NullOr(Schema.String));
const Numeric = Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Finite, Schema.String])));
const RequestArgumentsSchema = Schema.Struct({
  action: Text,
  command: Text,
  cwd: Text,
  name: Text,
  timeoutSeconds: Numeric,
  notify: Text,
  id: Text,
  state: Text,
  until: Text,
  contains: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  afterCursor: Numeric,
  tailLines: Numeric,
  waitSeconds: Numeric,
  force: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
type RequestArguments = typeof RequestArgumentsSchema.Type;
type RequestField = keyof RequestArguments;

const REQUEST_FIELDS: ReadonlyArray<RequestField> = [
  "action",
  "command",
  "cwd",
  "name",
  "timeoutSeconds",
  "notify",
  "id",
  "state",
  "until",
  "contains",
  "afterCursor",
  "tailLines",
  "waitSeconds",
  "force",
];

const decodeExactRequest = Schema.decodeUnknownOption(RequestArgumentsSchema, {
  onExcessProperty: "error",
});
const decodeKnownRequest = Schema.decodeUnknownOption(RequestArgumentsSchema);

const isPresent = (value: RequestArguments[RequestField]): boolean =>
  value !== undefined && value !== null && !(Predicate.isString(value) && Str.trim(value) === "");

const textValue = (value: string | null | undefined): string | undefined =>
  Predicate.isString(value) && Str.trim(value) !== "" ? value : undefined;

const numberValue = (value: number | string | null | undefined): number | undefined => {
  const number = Predicate.isString(value) && Str.trim(value) !== "" ? Number(value) : value;
  return Predicate.isNumber(number) && Number.isFinite(number) ? number : undefined;
};

const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * An argument as visible text: each control character becomes a marker instead of being stripped
 * with whatever an escape sequence would have hidden, so expansion never hides input.
 */
const visibleText = (text: string): string =>
  Arr.join(
    Arr.map(Array.from(text), (char) =>
      char === "\t" ? "  " : CONTROL_CHARACTER.test(char) ? "\uFFFD" : char,
    ),
    "",
  );

/** A command's display lines, which keep its line breaks. */
export const commandLines = (text: string): string[] =>
  Arr.map(Str.split(Fn.pipe(text, Str.replace(/\r\n?/gu, "\n")), "\n"), visibleText);

/** Whole seconds read as a duration; other values keep their exact number beside it. */
const secondsText = (seconds: number): string => {
  const duration = formatDuration(seconds * 1_000);
  const exact = Number.isInteger(seconds) && (seconds < 3_600 || seconds % 60 === 0);
  return exact ? duration : `${duration} (${seconds}s)`;
};

const row = (label: string, ...lines: string[]): LabeledRow => ({ label, lines });

function startRows(args: RequestArguments): LabeledRow[] {
  const name = textValue(args.name);
  const command = textValue(args.command);
  return [
    // The heading shows the name; only a name it had to sanitize appears again, exactly.
    ...(name !== undefined && sanitizeTerminalLine(Str.trim(name)) !== visibleText(Str.trim(name))
      ? [row("Name", visibleText(name))]
      : []),
    // The heading clips a long command, so the command always appears in full.
    ...(command === undefined ? [] : [row("Command", ...commandLines(command))]),
  ];
}

function waitTarget(args: RequestArguments): string | undefined {
  if (args.until === "exit") return "the task to exit";
  const { contains } = args;
  const texts = Predicate.isString(contains) ? [contains] : (contains ?? []);
  // Expansion shows each alternative whole, unlike the heading's clipped quote.
  const quoted = Arr.map(
    Arr.filter(texts, (text) => text !== ""),
    (text) => `"${visibleText(text)}"`,
  );
  if (quoted.length === 0) return args.until === "output" ? "output" : undefined;
  const last = quoted.at(-1) ?? "";
  return quoted.length === 1 ? last : `${Arr.join(quoted.slice(0, -1), ", ")} or ${last}`;
}

/** The request's arguments as rows, and whether those rows show every argument. */
export interface BackgroundTaskRequestView {
  readonly rows: ReadonlyArray<LabeledRow>;
  readonly complete: boolean;
}

function requestRows(args: RequestArguments): ReadonlyArray<LabeledRow> {
  const rows: LabeledRow[] = args.action === "start" ? startRows(args) : [];
  const cwd = textValue(args.cwd);
  if (cwd !== undefined) rows.push(row("Directory", visibleText(cwd)));
  const timeout = numberValue(args.timeoutSeconds);
  if (timeout !== undefined)
    rows.push(row("Time limit", timeout > 0 ? secondsText(timeout) : "none"));
  if (args.notify === "exit" || args.notify === "failure")
    rows.push(row("Notify", NOTIFY_LABELS[args.notify]));
  if (args.action === "list" && args.state === "all") rows.push(row("Showing", "all tasks"));
  const target = args.action === "wait" ? waitTarget(args) : undefined;
  if (target !== undefined) rows.push(row("Wait for", target));
  const tail = numberValue(args.tailLines);
  if (tail !== undefined) rows.push(row("Newest lines", tail > 0 ? String(tail) : "default"));
  const after = numberValue(args.afterCursor);
  if (after !== undefined) rows.push(row("After cursor", String(after)));
  const wait = numberValue(args.waitSeconds);
  if (wait !== undefined) rows.push(row("Wait up to", wait > 0 ? secondsText(wait) : "no wait"));
  if (args.force === true) rows.push(row("Force", "immediate termination"));
  return rows;
}

/** Whether a present field reads in words, is stated by the row's heading, or leads its Details. */
function fieldShown(args: RequestArguments, field: RequestField): boolean {
  switch (field) {
    // A false force is the default, which needs no words.
    case "action":
    case "cwd":
    case "id":
    case "force":
      return true;
    case "notify":
      return args.notify === "exit" || args.notify === "failure";
    case "command":
    case "name":
      return args.action === "start";
    case "state":
      return (
        args.action === "list" &&
        (args.state === "active" || args.state === "completed" || args.state === "all")
      );
    case "until":
    case "contains":
      return args.action === "wait" && waitTarget(args) !== undefined;
    case "timeoutSeconds":
    case "afterCursor":
    case "tailLines":
    case "waitSeconds":
      return numberValue(args[field]) !== undefined;
  }
  return false;
}

/**
 * The request's arguments as labeled human-readable rows. Fields the heading already states are
 * left out; the view is incomplete when an argument couldn't be shown this way.
 */
export function backgroundTaskRequestRows(args: unknown): BackgroundTaskRequestView {
  const exact = decodeExactRequest(args);
  const known = Option.isSome(exact) ? exact : decodeKnownRequest(args);
  if (Option.isNone(known)) return { rows: [], complete: false };
  const decoded = known.value;
  return {
    rows: requestRows(decoded),
    complete:
      Option.isSome(exact) &&
      Arr.every(
        REQUEST_FIELDS,
        (field) => !isPresent(decoded[field]) || fieldShown(decoded, field),
      ),
  };
}

/** The task a request names, as its expanded Details show it. */
export function requestTaskId(args: unknown): string | undefined {
  const known = decodeKnownRequest(args);
  const id = Option.isSome(known) ? textValue(known.value.id) : undefined;
  return id === undefined ? undefined : visibleText(id);
}

/**
 * The expanded call: the request in words, plus the raw arguments when words can't show it all.
 * The task ID belongs to Details: the result's once it arrives, the request's until then.
 */
export function renderBackgroundTaskRequest(
  args: Partial<BackgroundTaskToolInput>,
  theme: Theme,
  settled: boolean,
): Component {
  const { rows, complete } = backgroundTaskRequestRows(args);
  const children: Component[] = [];
  if (rows.length > 0) children.push(expandedFields(theme, rows));
  if (!complete) children.push(expandedArguments(theme, args));
  const id = settled ? undefined : requestTaskId(args);
  if (id !== undefined) children.push(expandedDetails(theme, [id]));
  return {
    render: (width) => Arr.flatMap(children, (child) => child.render(width)),
    invalidate: () => {
      for (const child of children) child.invalidate();
    },
  };
}
