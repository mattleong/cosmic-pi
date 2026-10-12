import * as Schema from "effect/Schema";
import { countLabel, decodeUnknownOrUndefined, stripTerminalControls } from "pi-cosmic-core";
import { MAX_RETAINED_REQUESTS } from "../questionnaire/async-model.ts";
import { MAX_CHOICES, MAX_QUESTIONS } from "../questionnaire/schema.ts";

export const projection =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  <Input>(input: Input): S["Type"] | undefined =>
    decodeUnknownOrUndefined(schema, input);

const note = { note: Schema.optional(Schema.String) };

export const answerOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("cancelled") }),
  Schema.Struct({
    outcome: Schema.Literal("submitted"),
    answers: Schema.Array(
      Schema.Union([
        Schema.Struct({
          key: Schema.String,
          kind: Schema.Literal("choices"),
          labels: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_CHOICES)),
          ...note,
        }),
        Schema.Struct({
          key: Schema.String,
          kind: Schema.Literals(["custom", "text"]),
          text: Schema.String,
          ...note,
        }),
      ]),
    ).check(Schema.isMaxLength(MAX_QUESTIONS)),
  }),
]);
export type ReplayedOutcome = typeof answerOutcome.Type;
export type ReplayedAnswer = Extract<ReplayedOutcome, { outcome: "submitted" }>["answers"][number];
export const decodeOutcome = projection(answerOutcome);

const asyncSnapshotFields = {
  requestId: Schema.String,
  deliveryId: Schema.String,
  status: Schema.Literals(["pending", "submitted", "cancelled", "failed"]),
  delivery: Schema.Literals(["pending", "sending", "sent", "failed", "waiter", "none"]),
  outcome: Schema.optional(answerOutcome),
  presentation: Schema.optional(
    Schema.Literals(["queued", "opening", "open", "hidden", "settled"]),
  ),
};

const compactIdentity = Schema.String.check(Schema.isBetweenLength(1, 256));
const compactAsyncSnapshot = Schema.Struct({
  ...asyncSnapshotFields,
  requestId: compactIdentity,
  deliveryId: compactIdentity,
});
const expandedAsyncSnapshot = Schema.Struct({
  ...asyncSnapshotFields,
  independentWork: Schema.optional(Schema.String),
  blockedWork: Schema.optional(Schema.String),
});
export type ReplayedSnapshot = typeof expandedAsyncSnapshot.Type;

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

export const isStatusList = <Args>(args: Args): boolean => {
  const control = decodeAsyncControl(args);
  return control?.action === "status" && control.requestId === undefined;
};

export const decodeCallQuestions = projection(
  Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({ title: Schema.String, key: Schema.optional(Schema.String) }),
    ).check(Schema.isMaxLength(MAX_QUESTIONS)),
  }),
);

export const callTitles = <Args>(args: Args): string | undefined => {
  const titles = decodeCallQuestions(args)
    ?.questions.map((question) => stripTerminalControls(question.title))
    .join(", ");
  return titles === "" ? undefined : titles;
};

export const titlesByKey = <Args>(args: Args): ReadonlyMap<string, string> =>
  new Map(
    (decodeCallQuestions(args)?.questions ?? []).flatMap((question) =>
      question.key === undefined ? [] : [[question.key, question.title] as const],
    ),
  );

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

export type QuestionnaireState = "waiting" | "queued" | "answered" | "cancelled" | "failed";

type StateRow = Pick<ReplayedSnapshot, "status" | "delivery" | "presentation" | "outcome">;

function pendingState(row: StateRow): QuestionnaireState | undefined {
  if (row.outcome || row.delivery !== "pending" || row.presentation === "settled") return undefined;
  return row.presentation === "queued" ? "queued" : "waiting";
}

function finishedState(
  row: StateRow,
  status: "submitted" | "cancelled",
): QuestionnaireState | undefined {
  if (row.outcome && row.outcome.outcome !== status) return undefined;
  if (row.outcome?.outcome === "submitted" && row.outcome.answers.length === 0) return undefined;
  return status === "submitted" ? "answered" : "cancelled";
}

export function questionnaireState(row: StateRow): QuestionnaireState | undefined {
  switch (row.status) {
    case "pending":
      return pendingState(row);
    case "failed":
      return row.outcome ? undefined : "failed";
    case "submitted":
    case "cancelled":
      return finishedState(row, row.status);
  }
}

const STATE_WORDS = {
  waiting: ["waiting for answers", "waiting"],
  queued: ["queued", "queued"],
  answered: ["answered", "answered"],
  cancelled: ["cancelled", "cancelled"],
  failed: ["failed", "failed"],
} as const satisfies Readonly<Record<QuestionnaireState, readonly [string, string]>>;
const STATE_ORDER: readonly QuestionnaireState[] = [
  "failed",
  "waiting",
  "queued",
  "answered",
  "cancelled",
];

export const stateWords = (state: QuestionnaireState): readonly string[] => [
  ...new Set(STATE_WORDS[state]),
];

export function stateCounts(states: readonly QuestionnaireState[]): readonly string[] {
  if (states.length === 0) return ["none retained", "none"];
  const counted = STATE_ORDER.flatMap((state) => {
    const count = states.filter((entry) => entry === state).length;
    return count === 0 ? [] : [[count, STATE_WORDS[state]] as const];
  });
  const wording = (short: 0 | 1) =>
    counted.map(([count, words]) => `${count} ${words[short]}`).join(", ");
  return [...new Set([wording(0), wording(1), countLabel(states.length, "questionnaire")])];
}
