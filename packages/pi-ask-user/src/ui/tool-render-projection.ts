import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core/display";
import { joinInline } from "pi-cosmic-ui/manager";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { MAX_RETAINED_REQUESTS, type PendingPresentation } from "../questionnaire/async-model.ts";
import {
  MAX_CHOICES,
  MAX_KEY_LENGTH,
  MAX_QUESTIONS,
  MAX_TITLE_LENGTH,
} from "../questionnaire/schema.ts";
import { titleLabel } from "./layout.ts";

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

/**
 * The progress a live call reports about its questions: on screen, hidden, or queued behind
 * others. A blocking questionnaire reports only that it opened.
 */
const PresentationProgressSchema = Schema.Struct({
  questionnaire: Schema.Literals(["open", "hidden", "queued"]),
});
export type PresentationProgress = typeof PresentationProgressSchema.Type;
export const presentationProgress = (presentation: PendingPresentation): PresentationProgress => ({
  questionnaire: presentation,
});
export const QUESTIONS_SHOWN = presentationProgress("open");
const decodePresentationProgress = decodeUnknownOrUndefined(PresentationProgressSchema);
/** The presentation a live call's progress `details` report, if any. */
export const decodePresentation = Fn.flow(
  decodePresentationProgress,
  (progress): PendingPresentation | undefined => progress?.questionnaire,
);
export type ReplayedAnswer = Extract<ReplayedOutcome, { outcome: "submitted" }>["answers"][number];
export const decodeOutcome = decodeUnknownOrUndefined(answerOutcome);

const asyncSnapshotFields = {
  requestId: Schema.String,
  deliveryId: Schema.String,
  status: Schema.Literals(["pending", "submitted", "cancelled", "failed"]),
  delivery: Schema.Literals(["pending", "sending", "sent", "failed", "waiter", "none"]),
  outcome: Schema.optional(answerOutcome),
  presentation: Schema.optional(
    Schema.Literals(["queued", "opening", "open", "hidden", "settled"]),
  ),
  // Decoded on its own by titlesOf, so a malformed label never hides the row.
  titles: Schema.optional(Schema.Unknown),
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
  const list = Schema.Struct({
    requests: Schema.Array(snapshot).check(Schema.isMaxLength(MAX_RETAINED_REQUESTS)),
  });
  const isList = Schema.is(list);
  return Fn.flow(
    decodeUnknownOrUndefined(Schema.Union([snapshot, list])),
    (decoded): readonly S["Type"][] | undefined => {
      if (decoded === undefined) return undefined;
      return isList(decoded) ? decoded.requests : [decoded];
    },
  );
};
export const decodeCompactAsyncRows = asyncRows(compactAsyncSnapshot);
export const decodeExpandedAsyncRows = asyncRows(expandedAsyncSnapshot);

export const decodeAsyncControl = decodeUnknownOrUndefined(
  Schema.Struct({
    action: Schema.Literals(["status", "await", "cancel"]),
    requestId: Schema.optional(Schema.String),
  }),
);

export const isStatusList = Fn.flow(
  decodeAsyncControl,
  (control) => control?.action === "status" && control.requestId === undefined,
);

export const decodeCallQuestions = decodeUnknownOrUndefined(
  Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({ title: Schema.String, key: Schema.optional(Schema.String) }),
    ).check(Schema.isMaxLength(MAX_QUESTIONS)),
  }),
);

const titlesLabel = (titles: ReadonlyArray<{ readonly title: string }>): string | undefined => {
  const label = Arr.join(
    Arr.map(titles, ({ title }) => titleLabel(title)),
    ", ",
  );
  return label === "" ? undefined : label;
};

export const callTitles = Fn.flow(decodeCallQuestions, (decoded) =>
  titlesLabel(decoded?.questions ?? []),
);

const decodeTitles = decodeUnknownOrUndefined(
  Schema.Array(
    Schema.Struct({
      key: Schema.String.check(Schema.isMaxLength(MAX_KEY_LENGTH)),
      title: Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH)),
    }),
  ).check(Schema.isMaxLength(MAX_QUESTIONS)),
);

/** Stored async question titles as one heading subject, or undefined when they don't decode. */
export const storedTitlesLabel = Fn.flow(decodeTitles, (titles) => titlesLabel(titles ?? []));

/** Question titles by answer key from stored async details; none when they don't decode. */
export const titlesOf = Fn.flow(
  decodeTitles,
  (titles): ReadonlyMap<string, string> =>
    new Map(Arr.map(titles ?? [], ({ key, title }) => [key, title] as const)),
);

export const titlesByKey = Fn.flow(
  decodeCallQuestions,
  (decoded): ReadonlyMap<string, string> =>
    new Map(
      Arr.filterMap(decoded?.questions ?? [], (question) =>
        question.key === undefined
          ? Result.failVoid
          : Result.succeed([question.key, question.title] as const),
      ),
    ),
);

/** What a questionnaire call asked, for its readable expanded request. */
export const decodeRequestView = decodeUnknownOrUndefined(
  Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        prompt: Schema.String,
        mode: Schema.optional(Schema.Literals(["single", "multiple", "text"])),
        choices: Schema.optional(
          Schema.Array(
            Schema.Struct({
              label: Schema.String,
              description: Schema.optional(Schema.String),
              preview: Schema.optional(Schema.String),
            }),
          ).check(Schema.isMaxLength(MAX_CHOICES)),
        ),
      }),
    ).check(Schema.isMaxLength(MAX_QUESTIONS)),
    independentWork: Schema.optional(Schema.String),
    blockedWork: Schema.optional(Schema.String),
  }),
);
export type RequestView = NonNullable<ReturnType<typeof decodeRequestView>>;

// Tool arguments are always objects; anything else has no fields to show.
const ArgumentFields = Schema.Record(Schema.String, Schema.Unknown);

/** A call's arguments, read as an async control, a questionnaire, or plain fields. */
export interface RequestArguments {
  readonly fields: typeof ArgumentFields.Type;
  readonly control: ReturnType<typeof decodeAsyncControl>;
  readonly request: RequestView | undefined;
}

export const requestArguments = Fn.flow(
  decodeUnknownOrUndefined(ArgumentFields),
  (fields): RequestArguments | undefined =>
    fields && {
      fields,
      control: decodeAsyncControl(fields),
      request: decodeRequestView(fields),
    },
);

export const decodeCompactChoices = decodeUnknownOrUndefined(
  Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        // Text questions have no choices.
        choices: Schema.optional(
          Schema.Array(Schema.Struct({ label: Schema.String })).check(
            Schema.isMaxLength(MAX_CHOICES),
          ),
        ),
      }),
    ).check(Schema.isMaxLength(MAX_QUESTIONS)),
  }),
);
const parts = decodeUnknownOrUndefined(Schema.Array(Schema.Unknown));
const textPart = decodeUnknownOrUndefined(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);
const replayContent = decodeUnknownOrUndefined(
  Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
);

const partsText = (decoded: ReadonlyArray<unknown> | undefined): string =>
  Arr.join(
    Arr.filterMap(decoded ?? [], (part) => {
      const text = textPart(part);
      return text ? Result.succeed(stripTerminalControls(text.text)) : Result.failVoid;
    }),
    "\n",
  );

export const fallbackText = Fn.flow(parts, partsText);

export const contentText = Fn.flow(replayContent, (decoded) =>
  Predicate.isString(decoded) ? stripTerminalControls(decoded) : partsText(decoded),
);

/** `waiting` is on screen; `hidden` is open but hidden until the user resumes it. */
export type QuestionnaireState =
  | "waiting"
  | "hidden"
  | "queued"
  | "answered"
  | "cancelled"
  | "failed";

/** Waiting, hidden, and queued questionnaires still need the user's answers. */
export const isPendingState = (state: QuestionnaireState): boolean =>
  state === "waiting" || state === "hidden" || state === "queued";

type StateRow = Pick<ReplayedSnapshot, "status" | "delivery" | "presentation" | "outcome">;

function pendingState(row: StateRow): QuestionnaireState | undefined {
  if (row.outcome || row.delivery !== "pending" || row.presentation === "settled") return undefined;
  return row.presentation === "queued" || row.presentation === "hidden"
    ? row.presentation
    : "waiting";
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
  return undefined;
}

// One name for each state, for one questionnaire or several: a narrow row shortens the subject,
// never the state.
const STATE_WORDS = {
  waiting: (count) => (count === 1 ? "needs your input" : "need your input"),
  hidden: () => "hidden",
  queued: () => "queued",
  answered: () => "answered",
  cancelled: () => "cancelled",
  failed: () => "failed",
} as const satisfies Readonly<Record<QuestionnaireState, (count: number) => string>>;
const STATE_ORDER: readonly QuestionnaireState[] = [
  "failed",
  "waiting",
  "hidden",
  "queued",
  "answered",
  "cancelled",
];

export const stateWords = (state: QuestionnaireState): readonly string[] => [STATE_WORDS[state](1)];

/**
 * Alternatives, widest first: every state's count, then the most pressing state among them all
 * (`1 of 3 needs your input`), so a narrow row keeps that state's words before only a total.
 */
export function stateCounts(states: readonly QuestionnaireState[]): readonly string[] {
  if (states.length === 0) return ["no questionnaires", "none"];
  const counted = Arr.filterMap(STATE_ORDER, (state) => {
    const count = Arr.filter(states, (entry) => entry === state).length;
    return count === 0
      ? Result.failVoid
      : Result.succeed([count, STATE_WORDS[state](count)] as const);
  });
  const wording = joinInline(Arr.map(counted, ([count, word]) => `${count} ${word}`));
  const [first, ...others] = counted;
  const pressing =
    first && others.length > 0 ? [`${first[0]} of ${states.length} ${first[1]}`] : [];
  return [...new Set([wording, ...pressing, countLabel(states.length, "questionnaire")])];
}

const DELIVERY_WORDS = {
  pending: "not delivered yet",
  sending: "delivering",
  sent: "delivered automatically",
  failed: "automatic delivery failed",
  waiter: "returned to an await",
  none: undefined,
} as const satisfies Readonly<Record<ReplayedSnapshot["delivery"], string | undefined>>;

const factLine = (segments: ReadonlyArray<string | undefined>): string =>
  Arr.join(
    Arr.filter(segments, (segment): segment is string => segment !== undefined && segment !== ""),
    " · ",
  );

/** IDs and delivery of async requests, for expanded details; a list also names each state. */
export function requestFacts(rows: readonly ReplayedSnapshot[], list: boolean): string[] {
  return Arr.map(rows, (row) => {
    const state = questionnaireState(row);
    return factLine([
      list && state !== undefined ? `${row.requestId}: ${STATE_WORDS[state](1)}` : row.requestId,
      `delivery ID ${row.deliveryId}`,
      DELIVERY_WORDS[row.delivery],
    ]);
  });
}

export const deliveryFacts = (requestId: string, deliveryId: string): string[] => [
  factLine([requestId, `delivery ID ${deliveryId}`]),
];
