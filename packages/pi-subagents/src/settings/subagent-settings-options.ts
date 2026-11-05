import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { completeSettingsArguments } from "pi-cosmic-core/settings-completion";
import {
  DELEGATION_MODES,
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_ACTIVE_RUNS,
  MAX_ACTIVE_RUNS,
  MIN_SUBAGENT_DEPTH,
  WRITER_WORKSPACE_MODES,
  type SubagentNestingOverrides,
} from "../config/schema.ts";

export type NestingField = keyof SubagentNestingOverrides;

export const WORKSPACE = "writerWorkspace";
export const WORKSPACE_LABEL = "Writer workspace";
export const DELEGATION = "delegation";
export const DELEGATION_LABEL = "Delegation";
export const INHERIT = "inherit";

export const DELEGATION_DESCRIPTION =
  "How much the main agent delegates to subagents: normal leaves its prompt unchanged, encouraged prefers subagents, and orchestration delegates nearly all substantive work.";

interface NestingFieldInfo {
  readonly label: string;
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly presets: readonly string[];
}

export const NESTING_FIELDS = {
  maxDirectChildren: {
    label: "Max children",
    description: "How many subagents one subagent may start at a time.",
    minimum: MIN_DIRECT_CHILDREN,
    maximum: MAX_DIRECT_CHILDREN,
    presets: ["4", "8", "12", "16", "32"],
  },
  maxDepth: {
    label: "Max depth",
    description: "How many levels of subagents may start further subagents.",
    minimum: MIN_SUBAGENT_DEPTH,
    maximum: MAX_SUBAGENT_DEPTH,
    presets: ["0", "1", "2", "3", "5", "8"],
  },
  maxActiveRuns: {
    label: "Max active",
    description: "How many subagents may run at once across the whole tree.",
    minimum: MIN_ACTIVE_RUNS,
    maximum: MAX_ACTIVE_RUNS,
    presets: ["4", "8", "16", "32", "64"],
  },
} as const satisfies Record<NestingField, NestingFieldInfo>;

export const NESTING_FIELD_IDS = Rec.keys(NESTING_FIELDS);

export const isNestingField = Schema.is(Schema.Literals(NESTING_FIELD_IDS));

export const SCOPES = [
  { name: "session", description: "This session only" },
  { name: "global", description: "All new sessions" },
  { name: "project", description: "This trusted project" },
] as const;

/** Each setting's value in effect, as status's "In effect" section and help show it. */
export type SubagentSettingValues = Readonly<
  Record<typeof WORKSPACE | typeof DELEGATION | NestingField, string>
>;

export const WORKSPACE_DESCRIPTION =
  "Default for writers that don't set isolation. Saved for new sessions.";

export const SUBAGENT_SETTING_DESCRIPTORS = [
  {
    id: WORKSPACE,
    label: WORKSPACE_LABEL,
    description: WORKSPACE_DESCRIPTION,
    values: [...WRITER_WORKSPACE_MODES],
    currentValue: (values: SubagentSettingValues) => values[WORKSPACE],
  },
  {
    id: DELEGATION,
    label: DELEGATION_LABEL,
    description: DELEGATION_DESCRIPTION,
    values: [INHERIT, ...DELEGATION_MODES],
    currentValue: (values: SubagentSettingValues) => values[DELEGATION],
  },
  ...Arr.map(NESTING_FIELD_IDS, (field) => ({
    id: field,
    label: NESTING_FIELDS[field].label,
    description: NESTING_FIELDS[field].description,
    values: [INHERIT, ...NESTING_FIELDS[field].presets],
    openValues: true,
    currentValue: (values: SubagentSettingValues) => values[field],
  })),
];

export const SUBAGENT_SETTINGS_COMMAND = {
  name: "settings",
  description: "Delegation settings",
  complete: (prefix: string) =>
    completeSettingsArguments(
      prefix,
      SUBAGENT_SETTING_DESCRIPTORS,
      [
        { value: "status", label: "status", description: "Show current values" },
        { value: "help", label: "help", description: "Show setting ids" },
      ],
      Arr.map(SCOPES, (scope) => ({
        value: scope.name,
        label: scope.name,
        description: scope.description,
      })),
    ),
};
