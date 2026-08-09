export const DISALLOWED_LAUNCH_OVERRIDE_FIELDS = [
  "execution",
  "context",
  "writeIntent",
  "effort",
  "backend",
  "model",
] as const;

export type DisallowedLaunchOverrideField = (typeof DISALLOWED_LAUNCH_OVERRIDE_FIELDS)[number];

export const firstDisallowedLaunchOverride = (
  value: object,
): DisallowedLaunchOverrideField | undefined =>
  DISALLOWED_LAUNCH_OVERRIDE_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );

export const disallowedLaunchOverrideMessage = (
  field: DisallowedLaunchOverrideField,
  target = "subagent_start",
): string =>
  `[launch_override_not_allowed] ${target} does not accept ${field}. Configure host, runtime, model, effort, context, writeIntent, fastMode, and closeOnReport in the selected version 4 profile route.`;
