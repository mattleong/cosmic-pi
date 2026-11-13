import * as Rec from "effect/Record";
import type { JsonValue } from "pi-cosmic-core";
import { findOrUndefined } from "pi-cosmic-core/array";

const DISALLOWED_LAUNCH_OVERRIDE_FIELDS = [
  "execution",
  "context",
  "writeIntent",
  "effort",
  "backend",
  "routeContinuation",
  "supersedes",
] as const;

type DisallowedLaunchOverrideField = (typeof DISALLOWED_LAUNCH_OVERRIDE_FIELDS)[number];

type LaunchSpecFields = Readonly<
  { task?: JsonValue } & Partial<Record<DisallowedLaunchOverrideField, JsonValue>>
>;

export const firstDisallowedLaunchOverride = (
  value: LaunchSpecFields,
): DisallowedLaunchOverrideField | undefined =>
  findOrUndefined(DISALLOWED_LAUNCH_OVERRIDE_FIELDS, (field) =>
    Rec.has<string, unknown>(value, field),
  );

export const disallowedLaunchOverrideMessage = (
  field: DisallowedLaunchOverrideField,
  target = "agent_start",
): string =>
  `[launch_override_not_allowed] ${target} does not accept ${field}. Configure context, writeIntent, and openaiFastMode in the selected profile-set route; a launch may override only its model, as model: { runtime, model, effort }.`;
