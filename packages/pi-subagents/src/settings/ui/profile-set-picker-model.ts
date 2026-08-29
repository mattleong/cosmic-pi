import type { ResolvedProfileSetSelection } from "../../config/options.ts";
import type { SubagentConfigScope } from "../../config/store.ts";
import type {
  ProfileSettingsInspection,
  PersistentProfileSetRef,
} from "../profile-route-editor.ts";

export type ProfileSetPickerEntry =
  | {
      readonly kind: "inherit-project";
      readonly key: "project:inherit";
      readonly scope: "project";
      readonly current: boolean;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "builtin";
      readonly key: "global:builtin";
      readonly scope: "global";
      readonly current: boolean;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "invalid-default";
      readonly key: "project:invalid-default" | "global:invalid-default";
      readonly scope: SubagentConfigScope;
      readonly current: true;
      readonly label: string;
      readonly description: string;
    }
  | {
      readonly kind: "set";
      readonly key: string;
      readonly scope: SubagentConfigScope;
      readonly ref: PersistentProfileSetRef;
      readonly current: boolean;
      readonly scopeDefault: boolean;
      readonly invalid: boolean;
      readonly profileCount: number;
      readonly label: string;
      readonly description: string;
    };

const setKey = (scope: SubagentConfigScope, name: string): string => `${scope}:${name}`;

const decodedForScope = (inspection: ProfileSettingsInspection, scope: SubagentConfigScope) =>
  scope === "global" ? inspection.global : inspection.project;

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
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name): ProfileSetPickerEntry => {
      const profileSet = decoded.file.profileSets?.[name];
      const invalid =
        decoded.invalidProfileSets.includes(name) ||
        (decoded.file.defaultProfileSet === name && decoded.invalidDefaultProfileSet) ||
        !profileSet;
      const profileCount = profileSet ? Object.keys(profileSet.profiles).length : 0;
      const scopeDefault = decoded.file.defaultProfileSet === name;
      const currentSelection = inspection.config.currentProfileSet;
      const current = currentSelection.scope === scope && currentSelection.name === name;
      const badge = scope === "project" ? "[P]" : "[G]";
      return {
        kind: "set",
        key: setKey(scope, name),
        scope,
        ref: { scope, name },
        current,
        scopeDefault,
        invalid,
        profileCount,
        label: `${badge} ${name}`,
        description: invalid
          ? "invalid set · fails closed"
          : `${profileCount} explicit profile${profileCount === 1 ? "" : "s"}${scopeDefault && !current ? " · scope default" : ""}`,
      };
    });
};

export const profileSetPickerEntries = (
  inspection: ProfileSettingsInspection,
  projectTrusted: boolean,
): ReadonlyArray<ProfileSetPickerEntry> => {
  const current = inspection.config.currentProfileSet;
  const malformedProjectDefault =
    current.scope === "project" && current.invalid && current.name === undefined;
  const malformedGlobalDefault =
    current.scope === "global" && current.invalid && current.name === undefined;
  const projectEntries: ReadonlyArray<ProfileSetPickerEntry> = projectTrusted
    ? [
        {
          kind: "inherit-project",
          key: "project:inherit",
          scope: "project",
          current: false,
          label: "[P] Inherit global",
          description: `Use ${inspection.global.file.defaultProfileSet ? `[G] ${inspection.global.file.defaultProfileSet}` : "built-in routes"}`,
        },
        ...(malformedProjectDefault
          ? [
              {
                kind: "invalid-default" as const,
                key: "project:invalid-default" as const,
                scope: "project" as const,
                current: true as const,
                label: "[P] Invalid default",
                description: "Malformed default reference · fails closed",
              },
            ]
          : []),
        ...scopeEntries(inspection, "project"),
      ]
    : [];
  const globalEntries: ReadonlyArray<ProfileSetPickerEntry> = [
    {
      kind: "builtin",
      key: "global:builtin",
      scope: "global",
      current: current.scope === "builtin",
      label: "[G] Built-in routes",
      description: "No global default profile set",
    },
    ...(malformedGlobalDefault
      ? [
          {
            kind: "invalid-default" as const,
            key: "global:invalid-default" as const,
            scope: "global" as const,
            current: true as const,
            label: "[G] Invalid default",
            description: "Malformed default reference · fails closed",
          },
        ]
      : []),
    ...scopeEntries(inspection, "global"),
  ];
  return [...projectEntries, ...globalEntries];
};

export const initialProfileSetPickerIndex = (
  entries: ReadonlyArray<ProfileSetPickerEntry>,
  preferredScope?: SubagentConfigScope,
): number => {
  const preferredCurrent = entries.findIndex(
    (entry) => entry.current && (preferredScope === undefined || entry.scope === preferredScope),
  );
  if (preferredCurrent >= 0) return preferredCurrent;
  const preferred = entries.findIndex((entry) => entry.scope === preferredScope);
  if (preferred >= 0) return preferred;
  return Math.max(
    0,
    entries.findIndex((entry) => entry.current),
  );
};

export const qualifiedProfileSetLabel = (ref: PersistentProfileSetRef): string =>
  `[${ref.scope === "project" ? "P" : "G"}] ${ref.name}`;

export const profileSetSelectionLabel = (selection: ResolvedProfileSetSelection): string => {
  if (selection.scope === "builtin") return "[G] Built-in routes";
  const badge = selection.scope === "project" ? "[P]" : "[G]";
  return selection.invalid || !selection.name
    ? `${badge} Invalid default`
    : `${badge} ${selection.name}`;
};
