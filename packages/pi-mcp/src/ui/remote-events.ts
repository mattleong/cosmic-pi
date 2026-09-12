import * as Schema from "effect/Schema";
import type { McpProgress } from "../observations/model.ts";
import { sanitizeMcpDisplayText } from "./content-preview.ts";

export const progressData = (progress: McpProgress) => {
  let data: Schema.JsonObject = { progress: progress.progress };
  if (progress.total !== undefined) data = { ...data, total: progress.total };
  if (progress.message !== undefined)
    data = { ...data, message: sanitizeMcpDisplayText(progress.message).slice(0, 512) };
  return data;
};
const Partial = Schema.Struct({
  details: Schema.Struct({
    data: Schema.Struct({
      progress: Schema.Struct({
        progress: Schema.Finite,
        total: Schema.optionalKey(Schema.Finite),
        message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
      }),
    }),
  }),
});
export const progressLabel = <Value>(value: Value): string | undefined => {
  try {
    const { progress } = Schema.decodeUnknownSync(Partial)(value).details.data;
    return `Remote progress ${progress.progress}${progress.total === undefined ? "" : ` / ${progress.total}`}${progress.message ? `: ${sanitizeMcpDisplayText(progress.message)}` : ""}`;
  } catch {
    return undefined;
  }
};
