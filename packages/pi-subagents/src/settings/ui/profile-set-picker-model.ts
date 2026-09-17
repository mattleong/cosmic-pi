import { resolveNamedProfileSet } from "../../config/options.ts";
import {
  PROFILE_IDS,
  type ProfileId,
  type ProfileCandidate,
  type ProfileRouteSource,
} from "../../profiles/model.ts";
import type { SubagentConfigScope } from "../../config/store.ts";
import type {
  ProfileSettingsInspection,
  PersistentProfileSetRef,
} from "../profile-route-editor.ts";

export interface ProfileSetPreviewProfile {
  readonly id: ProfileId;
  readonly source: ProfileRouteSource;
  readonly inherited: boolean;
  readonly status: "configured" | "disabled" | "invalid";
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export type ProfileSetPickerEntry =
  | {
      readonly kind: "set";
      readonly key: string;
      readonly scope: SubagentConfigScope;
      readonly ref: PersistentProfileSetRef;
      readonly scopeDefault: boolean;
      readonly invalid: boolean;
      readonly repairable: boolean;
      readonly invalidProfileCount: number;
      readonly profileCount: number;
      readonly preview: ReadonlyArray<ProfileSetPreviewProfile>;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "invalid-default";
      readonly key: string;
      readonly scope: SubagentConfigScope;
      readonly scopeDefault: true;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "scope-note";
      readonly key: "project:locked" | "project:empty" | "global:empty";
      readonly scope: SubagentConfigScope;
      readonly label: string;
      readonly description: string;
      readonly unavailable: boolean;
    };

const setKey = (scope: SubagentConfigScope, name: string): string => `${scope}:${name}`;

const decodedForScope = (inspection: ProfileSettingsInspection, scope: SubagentConfigScope) =>
  scope === "global" ? inspection.global : inspection.project;

const resolvedSet = (
  inspection: ProfileSettingsInspection,
  scope: SubagentConfigScope,
  name: string,
) =>
  scope === "global"
    ? resolveNamedProfileSet({ scope, name, global: inspection.global })
    : resolveNamedProfileSet(
        inspection.project
          ? { scope, name, global: inspection.global, project: inspection.project }
          : { scope, name, global: inspection.global },
      );

const scopeEntries = (
  inspection: ProfileSettingsInspection,
  scope: SubagentConfigScope,
): ReadonlyArray<ProfileSetPickerEntry> => {
  const decoded = decodedForScope(inspection, scope);
  if (!decoded) return [];
  const names = new Set([
    ...Object.keys(decoded.file.profileSets ?? {}),
    ...decoded.invalidProfileSets,
    ...(decoded.file.defaultProfileSet ? [decoded.file.defaultProfileSet] : []),
  ]);
  const sets = [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name): ProfileSetPickerEntry => {
      const profileSet = decoded.file.profileSets?.[name];
      const resolved = resolvedSet(inspection, scope, name);
      const structurallyInvalid =
        resolved.status === "structurally-invalid" || resolved.status === "missing";
      const invalid = resolved.status !== "resolved";
      const repairable = invalid && !structurallyInvalid;
      const invalidProfileCount = resolved.invalidProfiles.length;
      const profileCount = profileSet ? Object.keys(profileSet.profiles).length : 0;
      const scopeDefault = decoded.file.defaultProfileSet === name;
      const status = [
        scopeDefault ? "default for new sessions" : undefined,
        invalid
          ? repairable
            ? `${invalidProfileCount} invalid profile${invalidProfileCount === 1 ? "" : "s"}, fix before use`
            : "invalid structure, delete and create a new set"
          : `${profileCount} saved profile${profileCount === 1 ? "" : "s"}`,
      ].filter((value): value is string => value !== undefined);
      return {
        kind: "set",
        key: setKey(scope, name),
        scope,
        ref: { scope, name },
        scopeDefault,
        invalid,
        repairable,
        invalidProfileCount,
        profileCount,
        preview: PROFILE_IDS.map((id) => {
          const source = resolved.profileSources[id];
          const candidates = resolved.profiles[id].candidates;
          return {
            id,
            source,
            inherited: source !== scope && source !== `${scope}-invalid`,
            status: resolved.invalidProfiles.includes(id)
              ? "invalid"
              : candidates.length === 0
                ? "disabled"
                : "configured",
            candidates,
          };
        }),
        label: name,
        description: status.join(" · "),
      };
    });
  return decoded.invalidDefaultProfileSet && decoded.file.defaultProfileSet === undefined
    ? [
        {
          kind: "invalid-default",
          key: `${scope}:invalid-default`,
          scope,
          scopeDefault: true,
          label: "Invalid default setting",
          description: `Clear the invalid ${scope === "project" ? "Project" : "Global"} default setting`,
        },
        ...sets,
      ]
    : sets;
};

export const profileSetPickerEntries = (
  inspection: ProfileSettingsInspection,
  projectTrusted: boolean,
): ReadonlyArray<ProfileSetPickerEntry> => {
  const project = projectTrusted
    ? scopeEntries(inspection, "project")
    : [
        {
          kind: "scope-note" as const,
          key: "project:locked" as const,
          scope: "project" as const,
          label: "Project sets unavailable",
          description: "Trust this project to view or edit its saved profile sets",
          unavailable: true,
        },
      ];
  const projectRows =
    projectTrusted && project.length === 0
      ? [
          {
            kind: "scope-note" as const,
            key: "project:empty" as const,
            scope: "project" as const,
            label: "No Project sets saved",
            description: "Save Current Session here to add one",
            unavailable: false,
          },
        ]
      : project;
  const global = scopeEntries(inspection, "global");
  const globalRows =
    global.length === 0
      ? [
          {
            kind: "scope-note" as const,
            key: "global:empty" as const,
            scope: "global" as const,
            label: "No Global sets saved",
            description: "Save Current Session here to add one",
            unavailable: false,
          },
        ]
      : global;
  return [...projectRows, ...globalRows];
};

export const initialProfileSetPickerIndex = (
  entries: ReadonlyArray<ProfileSetPickerEntry>,
  preferredScope?: SubagentConfigScope,
): number => {
  const defaultEntry = entries.findIndex(
    (entry) =>
      (entry.kind === "set" || entry.kind === "invalid-default") &&
      entry.scopeDefault &&
      (preferredScope === undefined || entry.scope === preferredScope),
  );
  if (defaultEntry >= 0) return defaultEntry;
  const preferred = entries.findIndex(
    (entry) =>
      entry.scope === preferredScope && (entry.kind === "set" || entry.kind === "invalid-default"),
  );
  if (preferred >= 0) return preferred;
  return Math.max(
    0,
    entries.findIndex((entry) => entry.kind === "set" || entry.kind === "invalid-default"),
  );
};

export const qualifiedProfileSetLabel = (ref: PersistentProfileSetRef): string =>
  `${ref.scope === "project" ? "Project" : "Global"}/${ref.name}`;
