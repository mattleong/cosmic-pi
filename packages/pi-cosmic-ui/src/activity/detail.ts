import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core/security";
import { ACTIVITY_LIMITS } from "./limits.ts";
import type { ActivityDetail, ActivityDetailField, ActivityDetailSection } from "./protocol.ts";

const TECHNICAL_FIELDS = 24;
const LABEL_LENGTH = 80;
const VALUE_LENGTH = 1_024;

const SectionSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.String,
  format: Schema.optional(Schema.Literals(["plain", "markdown"])),
});
const FieldSchema = Schema.Struct({ label: Schema.String, value: Schema.String });
const DetailShape = Schema.Struct({
  sections: Schema.Array(Schema.Unknown),
  technical: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeSection = Schema.decodeUnknownOption(SectionSchema);
const decodeField = Schema.decodeUnknownOption(FieldSchema);
const DetailContent = Schema.Union([Schema.String, DetailShape]);

// Indentation carries meaning in logs and Markdown, so bodies keep it and lose only controls.
const cleanLines = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(
    Arr.join(
      Arr.map(
        Str.split(stripTerminalControls(Fn.pipe(text, Str.slice(0, maximumLength))), "\n"),
        Fn.flow(Str.replaceAll("\t", "  "), Str.trimEnd),
      ),
      "\n",
    ),
    { maximumLength },
  );
const cleanLine = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(Fn.pipe(text, Str.slice(0, maximumLength))), {
    maximumLength,
  });

const cleanSections = (
  sections: ReadonlyArray<ActivityDetailSection>,
): ReadonlyArray<ActivityDetailSection> => {
  let remaining: number = ACTIVITY_LIMITS.detail;
  const cleaned: ActivityDetailSection[] = [];
  for (const section of sections) {
    if (remaining <= 0) break;
    const title = section.title === undefined ? "" : cleanLine(section.title, LABEL_LENGTH);
    // Output usually ends with a newline; trailing blank lines would only pad the pane.
    const body = Str.trimEnd(cleanLines(section.body, remaining));
    remaining -= body.length + title.length;
    if (!Str.isNonEmpty(Str.trim(body))) continue;
    cleaned.push({
      ...(title && { title }),
      body,
      ...(section.format === "markdown" && { format: "markdown" as const }),
    });
  }
  return cleaned;
};

const cleanFields = (
  fields: ReadonlyArray<ActivityDetailField>,
): ReadonlyArray<ActivityDetailField> =>
  Arr.flatMap(fields.slice(0, TECHNICAL_FIELDS), (field) => {
    const label = cleanLine(field.label, LABEL_LENGTH);
    const value = cleanLine(field.value, VALUE_LENGTH);
    return label && value ? [{ label, value }] : [];
  });

export const plainActivityDetail = (text: string): ActivityDetail => ({
  sections: cleanSections([{ body: text }]),
});

export const emptyActivityDetail: ActivityDetail = { sections: [] };

/**
 * Admits a producer's detail. Invalid sections or fields are dropped individually so the rest
 * still shows; anything that is neither a string nor a detail document is rejected.
 */
export const decodeActivityDetail = (value: unknown): ActivityDetail | undefined => {
  const content = Option.getOrUndefined(Schema.decodeUnknownOption(DetailContent)(value));
  if (content === undefined) return undefined;
  if (Predicate.isString(content)) return plainActivityDetail(content);
  const technical = cleanFields(
    Arr.flatMap(content.technical ?? [], (field) => Option.toArray(decodeField(field))),
  );
  return {
    sections: cleanSections(
      Arr.flatMap(content.sections, (section) => Option.toArray(decodeSection(section))),
    ),
    ...(technical.length > 0 && { technical }),
  };
};
