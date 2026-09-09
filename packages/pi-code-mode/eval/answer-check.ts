import { isDeepStrictEqual } from "node:util";
import * as Schema from "effect/Schema";
import type { EvalTask } from "./tasks.ts";

const isArray = Schema.is(Schema.Array(Schema.Json));
const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

/** Keep only bounded locations from the trusted oracle, never answer values or extra key names. */
function mismatchLocations(expected: Schema.Json, actual: Schema.Json): string[] {
  const paths: string[] = [];
  const walk = (before: Schema.Json, after: Schema.Json, path: string, depth: number): void => {
    if (paths.length >= 8 || isDeepStrictEqual(before, after)) return;
    if (depth >= 8) {
      paths.push(path || "/");
      return;
    }
    if (isArray(before) && isArray(after)) {
      if (before.length !== after.length) paths.push(`${path}/<length>`);
      for (let n = 0; n < Math.min(before.length, after.length) && paths.length < 8; n++)
        walk(before[n]!, after[n]!, `${path}/${n}`, depth + 1);
    } else if (isObject(before) && isObject(after)) {
      for (const key of Object.keys(before)) {
        if (paths.length >= 8) break;
        const child = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (!Object.hasOwn(after, key)) paths.push(`${child}/<missing>`);
        else walk(before[key]!, after[key]!, child, depth + 1);
      }
      if (paths.length < 8 && Object.keys(after).some((key) => !Object.hasOwn(before, key)))
        paths.push(`${path}/<extra-key>`);
    } else paths.push(path || "/");
  };
  walk(expected, actual, "", 0);
  return paths;
}

export function gradeAnswer(text: string, task: EvalTask) {
  // A surrounding fence is harmless presentation, not a correctness regression.
  const normalized = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  try {
    const answer = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(normalized);
    const correct = isDeepStrictEqual(answer, task.expected);
    return { correct, mismatchPaths: correct ? [] : mismatchLocations(task.expected, answer) };
  } catch {
    return { correct: false, mismatchPaths: ["<invalid-json>"] };
  }
}
