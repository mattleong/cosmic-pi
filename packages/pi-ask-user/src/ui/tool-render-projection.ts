import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, stripTerminalControls } from "pi-cosmic-core";
import { toolStatusLine } from "pi-cosmic-ui/tool";
import { MAX_RETAINED_REQUESTS } from "../questionnaire/async-model.ts";
import { MAX_CHOICES, MAX_QUESTIONS } from "../questionnaire/schema.ts";

/** Decodes untrusted replay data; hostile getters and mismatches yield undefined. */
export const projection =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  <Input>(input: Input): S["Type"] | undefined =>
    decodeUnknownOrUndefined(schema, input);

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

export const asyncOutcome = outcomeProjection({ note: Schema.optional(Schema.String) });

const asyncSnapshotFields = {
  requestId: Schema.String,
  deliveryId: Schema.String,
  status: Schema.Literals(["pending", "submitted", "cancelled", "failed"]),
  delivery: Schema.Literals(["pending", "sending", "sent", "failed", "waiter", "none"]),
  outcome: Schema.optional(asyncOutcome),
  presentation: Schema.optional(
    Schema.Literals(["queued", "opening", "open", "hidden", "settled"]),
  ),
};

// Historical expanded replay accepts any string ID. Compact identity needs a bounded, nonempty ID.
const compactIdentity = Schema.String.check(Schema.isLengthBetween(1, 256));
export const compactAsyncSnapshot = Schema.Struct({
  ...asyncSnapshotFields,
  requestId: compactIdentity,
  deliveryId: compactIdentity,
});
export const expandedAsyncSnapshot = Schema.Struct({
  ...asyncSnapshotFields,
  independentWork: Schema.optional(Schema.String),
  blockedWork: Schema.optional(Schema.String),
});

const asyncRows = <S extends Schema.ConstraintDecoder<unknown>>(snapshot: S) => {
  const decodeSingle = projection(snapshot);
  const decodeList = projection(
    Schema.Struct({
      requests: Schema.Array(snapshot).check(Schema.isMaxLength(MAX_RETAINED_REQUESTS)),
    }),
  );
  return <Input>(details: Input): readonly S["Type"][] | undefined => {
    const single = decodeSingle(details);
    return single ? [single] : decodeList(details)?.requests;
  };
};
export const decodeCompactAsyncRows = asyncRows(compactAsyncSnapshot);
export const decodeExpandedAsyncRows = asyncRows(expandedAsyncSnapshot);

export const decodeAsyncControl = projection(
  Schema.Struct({
    action: Schema.Literals(["status", "await", "cancel"]),
    requestId: Schema.optional(Schema.String),
  }),
);

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
