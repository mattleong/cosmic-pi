/** Code Mode configuration shape, defaults, documented bounds, and field codecs. */
import * as Schema from "effect/Schema";

export interface CodeModeIntegerBounds {
  readonly minimum: number;
  readonly maximum: number;
}

/** Values outside a bound are malformed and fall back independently; they are not clamped. */
export const CODE_MODE_INTEGER_BOUNDS = Object.freeze({
  /** Positive; capped at ten minutes so one program cannot pin a session. */
  timeoutMs: Object.freeze({ minimum: 1, maximum: 600_000 }),
  /** Non-negative; capped well above any practical per-program tool budget. */
  maxToolCalls: Object.freeze({ minimum: 0, maximum: 10_000 }),
  /** Non-negative; capped at 16 MiB of program output. */
  maxOutputBytes: Object.freeze({ minimum: 0, maximum: 16_777_216 }),
  /** Positive; capped at 1 MiB of model-written program source. */
  maxSourceBytes: Object.freeze({ minimum: 1, maximum: 1_048_576 }),
  /** Non-negative; capped at 256 MiB of cumulative child tool output. */
  maxCumulativeChildOutputBytes: Object.freeze({ minimum: 0, maximum: 268_435_456 }),
  /** Non-negative; capped at 100k estimated catalog tokens. */
  catalogBudget: Object.freeze({ minimum: 0, maximum: 100_000 }),
} satisfies Readonly<Record<string, CodeModeIntegerBounds>>);

export type CodeModeIntegerFieldId = keyof typeof CODE_MODE_INTEGER_BOUNDS;

const boundedInteger = (bounds: CodeModeIntegerBounds) =>
  Schema.Finite.check(Schema.isInt(), Schema.isBetween(bounds));

/** The one authoritative configuration schema. */
export const CodeModeConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  timeoutMs: boundedInteger(CODE_MODE_INTEGER_BOUNDS.timeoutMs),
  maxToolCalls: boundedInteger(CODE_MODE_INTEGER_BOUNDS.maxToolCalls),
  maxOutputBytes: boundedInteger(CODE_MODE_INTEGER_BOUNDS.maxOutputBytes),
  maxSourceBytes: boundedInteger(CODE_MODE_INTEGER_BOUNDS.maxSourceBytes),
  maxCumulativeChildOutputBytes: boundedInteger(
    CODE_MODE_INTEGER_BOUNDS.maxCumulativeChildOutputBytes,
  ),
  catalogBudget: boundedInteger(CODE_MODE_INTEGER_BOUNDS.catalogBudget),
});

export type CodeModeConfig = typeof CodeModeConfigSchema.Type;
export type CodeModeFieldId = keyof CodeModeConfig;

export const CODE_MODE_FIELD_IDS = Object.freeze(
  // SAFETY: The field ids and config type come from the same authoritative Struct.
  Object.keys(CodeModeConfigSchema.fields) as readonly CodeModeFieldId[],
);
export const CODE_MODE_FIELD_SCHEMAS = CodeModeConfigSchema.fields;

export const DEFAULT_CODE_MODE_CONFIG: CodeModeConfig = Object.freeze({
  enabled: true,
  timeoutMs: 30_000,
  maxToolCalls: 32,
  maxOutputBytes: 51_200,
  maxSourceBytes: 32_768,
  maxCumulativeChildOutputBytes: 2_097_152,
  catalogBudget: 2_000,
});

export const CODE_MODE_CONFIG_BASENAME = "pi-code-mode.json";
