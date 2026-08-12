/** Code Mode configuration shape, defaults, documented bounds, and field codecs. */
import * as Schema from "effect/Schema";

export interface CodeModeConfig {
  /** Master switch; availability additionally requires a trusted project. */
  readonly enabled: boolean;
  /** Interpreter wall-clock budget per program, in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum tool invocations per program. */
  readonly maxToolCalls: number;
  /** Maximum bytes of program output returned to the model. */
  readonly maxOutputBytes: number;
  /** Maximum bytes of model-supplied program source. */
  readonly maxSourceBytes: number;
  /** Cumulative bytes of child tool output one program may consume. */
  readonly maxCumulativeChildOutputBytes: number;
  /** Discovery catalog budget in estimated tokens. */
  readonly catalogBudget: number;
}

export const DEFAULT_CODE_MODE_CONFIG: CodeModeConfig = Object.freeze({
  enabled: true,
  timeoutMs: 30_000,
  maxToolCalls: 32,
  maxOutputBytes: 51_200,
  maxSourceBytes: 32_768,
  maxCumulativeChildOutputBytes: 2_097_152,
  catalogBudget: 2_000,
});

export const CODE_MODE_FIELD_IDS = [
  "enabled",
  "timeoutMs",
  "maxToolCalls",
  "maxOutputBytes",
  "maxSourceBytes",
  "maxCumulativeChildOutputBytes",
  "catalogBudget",
] as const;

export type CodeModeFieldId = (typeof CODE_MODE_FIELD_IDS)[number];

export type CodeModeIntegerFieldId = Exclude<CodeModeFieldId, "enabled">;

export interface CodeModeIntegerBounds {
  readonly minimum: number;
  readonly maximum: number;
}

/**
 * Documented, defensible bounds for the tolerant field decoders. Values outside a bound are
 * treated as malformed and fall back independently; they are never silently clamped.
 */
export const CODE_MODE_INTEGER_BOUNDS: Readonly<
  Record<CodeModeIntegerFieldId, CodeModeIntegerBounds>
> = Object.freeze({
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
});

const boundedInteger = (bounds: CodeModeIntegerBounds) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween(bounds));

/** Per-field tolerant decoders; a malformed field never discards its valid siblings. */
export const CODE_MODE_FIELD_SCHEMAS = {
  enabled: Schema.Boolean,
  timeoutMs: boundedInteger(CODE_MODE_INTEGER_BOUNDS.timeoutMs),
  maxToolCalls: boundedInteger(CODE_MODE_INTEGER_BOUNDS.maxToolCalls),
  maxOutputBytes: boundedInteger(CODE_MODE_INTEGER_BOUNDS.maxOutputBytes),
  maxSourceBytes: boundedInteger(CODE_MODE_INTEGER_BOUNDS.maxSourceBytes),
  maxCumulativeChildOutputBytes: boundedInteger(
    CODE_MODE_INTEGER_BOUNDS.maxCumulativeChildOutputBytes,
  ),
  catalogBudget: boundedInteger(CODE_MODE_INTEGER_BOUNDS.catalogBudget),
} as const;

export const CODE_MODE_CONFIG_BASENAME = "pi-code-mode.json";
