/** Field-wise resolution, provenance, and settings descriptors for Code Mode configuration. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CODE_MODE_FIELD_IDS,
  CODE_MODE_INTEGER_BOUNDS,
  DEFAULT_CODE_MODE_CONFIG,
  type CodeModeConfig,
  type CodeModeFieldId,
  type CodeModeIntegerFieldId,
} from "./schema.ts";

export type CodeModeSettingScope = "global" | "project";

export type CodeModeFieldProvenance = "default" | "global" | "project";

export type CodeModeProvenance = Readonly<Record<CodeModeFieldId, CodeModeFieldProvenance>>;

export interface CodeModeResolution {
  readonly config: CodeModeConfig;
  readonly provenance: CodeModeProvenance;
}

export class InvalidCodeModeSettingError extends Schema.TaggedErrorClass<InvalidCodeModeSettingError>()(
  "InvalidCodeModeSettingError",
  { id: Schema.String, message: Schema.String },
) {}

/**
 * Overlays project fields over global fields over package defaults, one field at a time.
 * Callers pass only fields that already passed the tolerant decoders, so a malformed project
 * field falls back to the global value (or the default) without dragging siblings with it.
 */
export function resolveCodeModeConfig(
  global: Partial<CodeModeConfig> | undefined,
  project: Partial<CodeModeConfig> | undefined,
): CodeModeResolution {
  const config: Record<string, boolean | number> = {};
  const provenance: Record<string, CodeModeFieldProvenance> = {};
  for (const field of CODE_MODE_FIELD_IDS) {
    const projectValue = project?.[field];
    const globalValue = global?.[field];
    if (projectValue !== undefined) {
      config[field] = projectValue;
      provenance[field] = "project";
    } else if (globalValue !== undefined) {
      config[field] = globalValue;
      provenance[field] = "global";
    } else {
      config[field] = DEFAULT_CODE_MODE_CONFIG[field];
      provenance[field] = "default";
    }
  }
  return {
    config: Object.freeze(config) as unknown as CodeModeConfig,
    provenance: Object.freeze(provenance) as CodeModeProvenance,
  };
}

interface CodeModeSettingDescriptorBase {
  readonly label: string;
  readonly description: string;
  /** Finite presets offered to completion and the interactive list; free integers are also valid. */
  readonly values: readonly string[];
  readonly decode: (
    rawValue: string,
  ) => Effect.Effect<boolean | number, InvalidCodeModeSettingError>;
  readonly format: (config: CodeModeConfig) => string;
}

export interface CodeModeBooleanSettingDescriptor extends CodeModeSettingDescriptorBase {
  readonly kind: "boolean";
  readonly id: CodeModeFieldId;
}

/** Integer settings accept any in-bounds value, not only the presets. */
export interface CodeModeIntegerSettingDescriptor extends CodeModeSettingDescriptorBase {
  readonly kind: "integer";
  readonly id: CodeModeIntegerFieldId;
}

export type CodeModeSettingDescriptor =
  | CodeModeBooleanSettingDescriptor
  | CodeModeIntegerSettingDescriptor;

const decodeBoolean = (id: CodeModeFieldId) => (rawValue: string) => {
  const trimmed = rawValue.trim();
  if (trimmed === "true") return Effect.succeed(true);
  if (trimmed === "false") return Effect.succeed(false);
  return Effect.fail(
    new InvalidCodeModeSettingError({
      id,
      message: `Invalid value for ${id}. Expected true or false.`,
    }),
  );
};

/** Bounded integer parsing: digits only, safe integer, and inside the documented bounds. */
const decodeBoundedInteger = (id: CodeModeIntegerFieldId) => (rawValue: string) => {
  const bounds = CODE_MODE_INTEGER_BOUNDS[id];
  const trimmed = rawValue.trim();
  const parsed = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isSafeInteger(parsed) && parsed >= bounds.minimum && parsed <= bounds.maximum) {
    return Effect.succeed(parsed);
  }
  return Effect.fail(
    new InvalidCodeModeSettingError({
      id,
      message: `Invalid value for ${id}. Expected an integer between ${bounds.minimum} and ${bounds.maximum}.`,
    }),
  );
};

const integerDescriptor = (options: {
  readonly id: CodeModeIntegerFieldId;
  readonly label: string;
  readonly description: string;
  readonly values: readonly string[];
}): CodeModeSettingDescriptor => ({
  kind: "integer",
  id: options.id,
  label: options.label,
  description: options.description,
  values: options.values,
  decode: decodeBoundedInteger(options.id),
  format: (config) => String(config[options.id]),
});

export const CODE_MODE_SETTING_DESCRIPTORS: readonly CodeModeSettingDescriptor[] = [
  {
    kind: "boolean",
    id: "enabled",
    label: "Code Mode enabled",
    description: "Enable Code Mode in trusted projects. Untrusted projects always stay off.",
    values: ["true", "false"],
    decode: decodeBoolean("enabled"),
    format: (config) => String(config.enabled),
  },
  integerDescriptor({
    id: "timeoutMs",
    label: "Program timeout (ms)",
    description: "Wall-clock budget per Code Mode program, in milliseconds.",
    values: ["5000", "15000", "30000", "60000", "120000", "300000"],
  }),
  integerDescriptor({
    id: "maxToolCalls",
    label: "Max tool calls",
    description: "Maximum tool invocations one Code Mode program may make.",
    values: ["8", "16", "32", "64", "128"],
  }),
  integerDescriptor({
    id: "maxOutputBytes",
    label: "Max output bytes",
    description: "Maximum bytes of program output returned to the model.",
    values: ["16384", "51200", "131072", "262144"],
  }),
  integerDescriptor({
    id: "maxSourceBytes",
    label: "Max source bytes",
    description: "Maximum bytes of model-written program source.",
    values: ["8192", "16384", "32768", "65536"],
  }),
  integerDescriptor({
    id: "maxCumulativeChildOutputBytes",
    label: "Max child output bytes",
    description: "Cumulative bytes of child tool output one program may consume.",
    values: ["524288", "1048576", "2097152", "8388608"],
  }),
  integerDescriptor({
    id: "catalogBudget",
    label: "Catalog budget (tokens)",
    description: "Discovery catalog budget in estimated tokens.",
    values: ["500", "1000", "2000", "4000", "8000"],
  }),
];

const DESCRIPTORS_BY_ID = new Map(
  CODE_MODE_SETTING_DESCRIPTORS.map((descriptor) => [descriptor.id as string, descriptor]),
);

export const findCodeModeSettingDescriptor = (id: string): CodeModeSettingDescriptor | undefined =>
  DESCRIPTORS_BY_ID.get(id);
