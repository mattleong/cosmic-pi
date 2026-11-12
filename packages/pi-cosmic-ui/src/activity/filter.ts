import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { activityStatus } from "./attention.ts";
import { isFinished, type ActivityRow } from "./model.ts";

const KIND_WORDS = {
  agent: "subagent agent",
  command: "task command",
  question: "question",
} as const satisfies Record<ActivityRow["kind"], string>;

// The words a row answers to: its title, identity, kind, and status in the words rows use, so
// `failed` or `running` filters by state.
const searchText = (row: ActivityRow): string =>
  Str.toLowerCase(
    Arr.join(
      [
        row.title,
        row.profile ?? "",
        row.model ?? "",
        row.modelDetail ?? "",
        KIND_WORDS[row.kind],
        row.status,
        activityStatus(row),
        isFinished(row) ? "finished" : "",
      ],
      "\n",
    ),
  );

/**
 * A matcher for a typed filter: every whitespace-separated word must appear, in any case, among
 * the row's title, profile, model, kind, and status words. A blank query filters nothing.
 */
export const activityFilterMatcher = (
  query: string,
): ((row: ActivityRow) => boolean) | undefined => {
  const words = Arr.filter(Str.split(Str.toLowerCase(Str.trim(query)), /\s+/), Str.isNonEmpty);
  if (!words.length) return undefined;
  const texts = new WeakMap<ActivityRow, string>();
  return (row) => {
    let text = texts.get(row);
    if (text === undefined) {
      text = searchText(row);
      texts.set(row, text);
    }
    const haystack = text;
    return Arr.every(words, (word) => Str.includes(word)(haystack));
  };
};
