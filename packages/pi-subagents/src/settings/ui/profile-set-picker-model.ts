import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import {
  PROFILE_IDS,
  type ProfileId,
  type ProfileCandidate,
  type ProfileRouteSource,
} from "../../profiles/model.ts";
import type { SubagentConfigScope } from "../../config/store.ts";
import {
  resolvedSet,
  SCOPE_LABELS,
  type ProfileSettingsInspection,
  type PersistentProfileSetRef,
} from "../profile-route-editor.ts";
import { countLabel } from "pi-cosmic-core";

interface ProfileSetPreviewProfile {
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
    };

const scopeEntries = (
  inspection: ProfileSettingsInspection,
  scope: SubagentConfigScope,
): ReadonlyArray<ProfileSetPickerEntry> => {
  const decoded = inspection[scope];
  if (!decoded) return [];
  const names = new Set([
    ...Rec.keys(decoded.file.profileSets ?? {}),
    ...decoded.invalidProfileSets,
    ...(decoded.file.defaultProfileSet ? [decoded.file.defaultProfileSet] : []),
  ]);
  const sets = Fn.pipe(
    Arr.sort([...names], (left: string, right: string) => Fn.pipe(left, Str.localeCompare(right))),
    Arr.map((name): ProfileSetPickerEntry => {
      const profileSet = decoded.file.profileSets?.[name];
      const resolved = resolvedSet(inspection, { scope, name });
      const structurallyInvalid =
        resolved.status === "structurally-invalid" || resolved.status === "missing";
      const invalid = resolved.status !== "resolved";
      const repairable = invalid && !structurallyInvalid;
      const invalidProfileCount = resolved.invalidProfiles.length;
      const profileCount = profileSet ? Rec.size<string, unknown>(profileSet.profiles) : 0;
      const scopeDefault = decoded.file.defaultProfileSet === name;
      const status = Arr.filter(
        [
          scopeDefault ? "default for new sessions" : undefined,
          invalid
            ? repairable
              ? `${countLabel(invalidProfileCount, "invalid profile")}, fix before use`
              : "invalid structure, delete and create a new set"
            : countLabel(profileCount, "saved profile"),
        ],
        Predicate.isNotUndefined,
      );
      return {
        kind: "set",
        key: `${scope}:${name}`,
        scope,
        ref: { scope, name },
        scopeDefault,
        invalid,
        repairable,
        preview: Arr.map(PROFILE_IDS, (id) => {
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
        description: Arr.join(status, " · "),
      };
    }),
  );
  return decoded.invalidDefaultProfileSet && decoded.file.defaultProfileSet === undefined
    ? [
        {
          kind: "invalid-default",
          key: `${scope}/invalid-default`,
          scope,
          scopeDefault: true,
          label: "Invalid default setting",
          description: `Clear the invalid ${SCOPE_LABELS[scope]} default setting`,
        },
        ...sets,
      ]
    : sets;
};

const emptyScopeNote = (scope: SubagentConfigScope): ProfileSetPickerEntry => ({
  kind: "scope-note",
  key: `${scope}:empty`,
  scope,
  label: `No ${SCOPE_LABELS[scope]} sets saved`,
  description: "Save Current Session here to add one",
});

export const profileSetPickerEntries = (
  inspection: ProfileSettingsInspection,
  projectTrusted: boolean,
): ReadonlyArray<ProfileSetPickerEntry> => {
  const project = projectTrusted ? scopeEntries(inspection, "project") : [];
  const global = scopeEntries(inspection, "global");
  return [
    ...(!projectTrusted
      ? [
          {
            kind: "scope-note",
            key: "project:locked",
            scope: "project",
            label: "Project sets unavailable",
            description: "Trust this project to view or edit its saved profile sets",
          } as const,
        ]
      : project.length === 0
        ? [emptyScopeNote("project")]
        : project),
    ...(global.length === 0 ? [emptyScopeNote("global")] : global),
  ];
};

export const initialProfileSetPickerIndex = (entries: ReadonlyArray<ProfileSetPickerEntry>) => {
  const defaultEntry = Option.getOrElse(
    Arr.findFirstIndex(entries, (entry) => entry.kind !== "scope-note" && entry.scopeDefault),
    () => -1,
  );
  return defaultEntry >= 0
    ? defaultEntry
    : Math.max(
        0,
        Option.getOrElse(
          Arr.findFirstIndex(entries, (entry) => entry.kind !== "scope-note"),
          () => -1,
        ),
      );
};

export const qualifiedProfileSetLabel = (ref: PersistentProfileSetRef): string =>
  `${SCOPE_LABELS[ref.scope]}/${ref.name}`;
