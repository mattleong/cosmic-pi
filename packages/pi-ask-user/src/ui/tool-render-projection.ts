import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stripTerminalControls } from "pi-cosmic-core";
import { toolStatusLine } from "pi-cosmic-ui/tool";
import { MAX_CHOICES, MAX_QUESTIONS } from "../questionnaire/schema.ts";

/** Decodes untrusted replay data; hostile getters and mismatches yield undefined. */
export const projection = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema);
  return <Input>(input: Input): S["Type"] | undefined => {
    try {
      return Option.getOrUndefined(decode(input));
    } catch {
      return undefined;
    }
  };
};

// Blocking replay deliberately never reads notes; async replay validates them.
export const outcomeProjection = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("cancelled") }),
    Schema.Struct({
      outcome: Schema.Literal("submitted"),
      answers: Schema.Array(
        Schema.Union([
          Schema.Struct({
            key: Schema.String,
            kind: Schema.Literal("choices"),
            labels: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_CHOICES)),
            ...fields,
          }),
          Schema.Struct({
            key: Schema.String,
            kind: Schema.Literals(["custom", "text"]),
            text: Schema.String,
            ...fields,
          }),
        ]),
      ).check(Schema.isMaxLength(MAX_QUESTIONS)),
    }),
  ]);

export const decodeCallTitles = projection(
  Schema.Struct({
    questions: Schema.Array(Schema.Struct({ title: Schema.String })).check(
      Schema.isMaxLength(MAX_QUESTIONS),
    ),
  }),
);
/** Compact-only evidence for matching a selected label; expanded replay stays title-only. */
export const decodeCompactChoices = projection(
  Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        choices: Schema.Array(Schema.Struct({ label: Schema.String })).check(
          Schema.isMaxLength(MAX_CHOICES),
        ),
      }),
    ).check(Schema.isMaxLength(MAX_QUESTIONS)),
  }),
);
const parts = projection(Schema.Array(Schema.Unknown));
const textPart = projection(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const stringContent = projection(Schema.String);

export function fallbackText<Content>(content: Content, allowString = false): string {
  if (allowString) {
    const text = stringContent(content);
    if (text !== undefined) return stripTerminalControls(text);
  }
  return (parts(content) ?? [])
    .flatMap((part) => {
      const text = textPart(part);
      return text ? [stripTerminalControls(text.text)] : [];
    })
    .join("\n");
}

export function answerLine(
  answer:
    | { readonly key: string; readonly kind: "choices"; readonly labels: readonly string[] }
    | { readonly key: string; readonly kind: "custom" | "text"; readonly text: string },
  theme: Theme,
): string {
  const value = answer.kind === "choices" ? answer.labels.join(", ") : answer.text;
  return toolStatusLine(
    theme,
    "success",
    `${stripTerminalControls(answer.key)}: ${stripTerminalControls(value)}`,
  );
}
