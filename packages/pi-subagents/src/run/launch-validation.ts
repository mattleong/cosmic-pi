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

export const firstDisallowedLaunchOverride = <Value extends object>(
  value: Value,
): DisallowedLaunchOverrideField | undefined =>
  DISALLOWED_LAUNCH_OVERRIDE_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  );

export const disallowedLaunchOverrideMessage = (
  field: DisallowedLaunchOverrideField,
  target = "subagent_start",
): string =>
  `[launch_override_not_allowed] ${target} does not accept ${field}. Configure host, runtime, model, effort, context, writeIntent, openaiFastMode, and closeOnReport in the selected profile-set route.`;
