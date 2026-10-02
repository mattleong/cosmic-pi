// Pi's authenticated classifier catalog and classify calls are Promise-shaped host boundaries.
import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  AUTOMATIC_ROUTING_QUESTION,
  classifierLabel,
  preferredJevClassifier,
  type ProfileClassifierResponse,
} from "../profiles/automatic-selection.ts";

const LOOKUP_TIMEOUT = Duration.seconds(5);
const CLASSIFY_TIMEOUT = Duration.seconds(15);
const MAX_CONCURRENT_CLASSIFICATIONS = 4;
const MAX_CATALOG_ENTRIES = 1_024;
const MAX_CATALOG_FIELD_CHARS = 256;

/** Cause-free by construction: provider text, credentials, and request content never cross. */
export class HostProfileClassifierError extends Schema.TaggedError<HostProfileClassifierError>()(
  "HostProfileClassifierError",
  {
    operation: Schema.Literals(["lookup", "classify"]),
    reason: Schema.Literals(["unsupported", "rejected", "timeout", "malformed"]),
  },
) {}

export interface HostProfileClassifier {
  /** Bounded, terminal-safe `provider/id` for routing provenance. */
  readonly label: string;
  /** One permit-bounded, interruptible classification decoded into the routing domain. */
  readonly classify: (
    context: ClassifierContext,
  ) => Effect.Effect<ProfileClassifierResponse, HostProfileClassifierError>;
}

export interface HostProfileClassifierSession {
  /**
   * The preferred authenticated Jev classifier, looked up at most once per session. Any lookup
   * failure, timeout, or unsupported host is `None`, which keeps the legacy generalist fallback.
   */
  readonly classifier: Effect.Effect<Option.Option<HostProfileClassifier>>;
}

type HostClassifierModel = ClassifierModel<ClassifierApi>;
type ClassifierRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getAvailableOfType" | "classify"
>;

const classifierError = (
  operation: HostProfileClassifierError["operation"],
  reason: HostProfileClassifierError["reason"],
) => new HostProfileClassifierError({ operation, reason });

/** Older hosts and partial test contexts lack the typed classifier API; that is unavailability. */
const classifierRegistry = (
  ctx: ExtensionContext,
): Effect.Effect<ClassifierRegistry, HostProfileClassifierError> =>
  Effect.try({
    try: () => {
      const registry = ctx.modelRegistry;
      return Predicate.isFunction(registry.getAvailableOfType) &&
        Predicate.isFunction(registry.classify)
        ? Option.some(registry)
        : Option.none();
    },
    catch: () => classifierError("lookup", "unsupported"),
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(classifierError("lookup", "unsupported")),
        onSome: Effect.succeed,
      }),
    ),
  );

const CatalogField = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CATALOG_FIELD_CHARS),
);
const CatalogEntry = Schema.Struct({
  type: Schema.Literal("classifier"),
  provider: CatalogField,
  id: CatalogField,
  api: CatalogField,
});
const decodeCatalogEntry = Schema.decodeUnknownOption(CatalogEntry);

const preferredClassifier = (models: ReadonlyArray<HostClassifierModel>) =>
  Effect.try({
    try: () =>
      Array.isArray(models)
        ? preferredJevClassifier(
            models.slice(0, MAX_CATALOG_ENTRIES).flatMap((model: HostClassifierModel) =>
              Option.match(decodeCatalogEntry(model), {
                onNone: () => [],
                onSome: (entry) => [{ entry, model }],
              }),
            ),
          )
        : undefined,
    catch: () => classifierError("lookup", "malformed"),
  });

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const decodeStatus = Schema.decodeUnknownOption(Schema.Struct({ stopReason: Schema.String }));
const decodeAnswer = Schema.decodeUnknownOption(
  Schema.Struct({
    answers: Schema.Struct({
      [AUTOMATIC_ROUTING_QUESTION]: Schema.Struct({
        type: Schema.Literal("choice"),
        choice: CatalogField,
        confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      }),
    }),
  }),
);
const decodeUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    usage: Schema.Struct({
      input: NonNegative,
      output: NonNegative,
      cacheRead: NonNegative,
      cacheWrite: NonNegative,
      totalTokens: NonNegative,
      cost: Schema.Struct({
        input: NonNegative,
        output: NonNegative,
        cacheRead: NonNegative,
        cacheWrite: NonNegative,
        total: NonNegative,
      }),
    }),
  }),
);

/** Keeps only the stop state, one well-formed choice answer, and reported usage. */
const classifierResponse = (result: ClassifierResult) =>
  Effect.try({
    try: () => {
      const status = decodeStatus(result);
      if (Option.isNone(status)) return Option.none<ProfileClassifierResponse>();
      const answer = decodeAnswer(result);
      const usage = decodeUsage(result);
      return Option.some<ProfileClassifierResponse>({
        stopped: status.value.stopReason === "stop",
        ...(Option.isSome(answer) && {
          answer: {
            choice: answer.value.answers[AUTOMATIC_ROUTING_QUESTION].choice,
            confidence: answer.value.answers[AUTOMATIC_ROUTING_QUESTION].confidence,
          },
        }),
        ...(Option.isSome(usage) && {
          usage: { ...usage.value.usage, cost: { ...usage.value.usage.cost } },
        }),
      });
    },
    catch: () => classifierError("classify", "malformed"),
  }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(classifierError("classify", "malformed")),
        onSome: Effect.succeed,
      }),
    ),
  );

const classifyWith =
  (registry: ClassifierRegistry, model: HostClassifierModel, permits: Semaphore.Semaphore) =>
  (context: ClassifierContext) =>
    permits.withPermits(1)(
      Effect.tryPromise({
        try: (signal) => registry.classify(model, context, { signal }),
        catch: () => classifierError("classify", "rejected"),
      }).pipe(
        Effect.timeoutOrElse({
          duration: CLASSIFY_TIMEOUT,
          orElse: () => Effect.fail(classifierError("classify", "timeout")),
        }),
        Effect.flatMap(classifierResponse),
      ),
    );

/**
 * One start batch's classifier boundary. Only the root tool context's authenticated catalog is
 * consulted; credentials, environment, and provider configuration are never read or changed.
 */
export const makeHostProfileClassifierSession = (
  ctx: ExtensionContext,
): Effect.Effect<HostProfileClassifierSession> =>
  Effect.gen(function* () {
    const permits = yield* Semaphore.make(MAX_CONCURRENT_CLASSIFICATIONS);
    const classifier = yield* Effect.cached(
      Effect.gen(function* () {
        const registry = yield* classifierRegistry(ctx);
        const models = yield* Effect.tryPromise({
          try: (signal) => registry.getAvailableOfType("classifier", undefined, { signal }),
          catch: () => classifierError("lookup", "rejected"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: LOOKUP_TIMEOUT,
            orElse: () => Effect.fail(classifierError("lookup", "timeout")),
          }),
        );
        const preferred = yield* preferredClassifier(models);
        return preferred === undefined
          ? Option.none<HostProfileClassifier>()
          : Option.some<HostProfileClassifier>({
              label: classifierLabel(preferred.entry),
              classify: classifyWith(registry, preferred.model, permits),
            });
      }).pipe(
        Effect.catchTag("HostProfileClassifierError", () =>
          Effect.succeed(Option.none<HostProfileClassifier>()),
        ),
      ),
    );
    return { classifier };
  });
