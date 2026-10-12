import type { JsonValue } from "pi-cosmic-core";

const DISALLOWED_LAUNCH_OVERRIDE_FIELDS = [
  "execution",
  "context",
  "writeIntent",
  "effort",
  "backend",
  "model",
  "routeContinuation",
  "supersedes",
] as const;

export type DisallowedLaunchOverrideField = (typeof DISALLOWED_LAUNCH_OVERRIDE_FIELDS)[number];

export type LaunchSpecFields = Readonly<
  { task?: JsonValue } & Partial<Record<DisallowedLaunchOverrideField, JsonValue>>
>;

export const firstDisallowedLaunchOverride = (
  value: LaunchSpecFields,
): DisallowedLaunchOverrideField | undefined =>
  DISALLOWED_LAUNCH_OVERRIDE_FIELDS.find((field) => Object.hasOwn(value, field));

export const disallowedLaunchOverrideMessage = (
  field: DisallowedLaunchOverrideField,
  target = "subagent_start",
): string =>
  `[launch_override_not_allowed] ${target} does not accept ${field}. Configure host, runtime, model, effort, context, writeIntent, openaiFastMode, and closeOnReport in the selected profile-set route.`;
