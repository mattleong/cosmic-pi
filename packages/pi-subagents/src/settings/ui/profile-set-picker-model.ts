import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
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
import { countLabel } from "pi-cosmic-core/display";

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
      /** The set the current session is based on. */
      readonly inUse: boolean;
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

/** Where a profile a set doesn't declare comes from, such as `built-in` or `from Global`. */
export const profileSourceLabel = (source: ProfileRouteSource): string => {
  const scope = Fn.pipe(source, Str.replace("-invalid", ""));
  return scope === "builtin"
    ? "built-in"
    : scope === "global" || scope === "project"
      ? `from ${SCOPE_LABELS[scope]}`
      : `from ${scope}`;
};

const ownSource = (scope: SubagentConfigScope, source: ProfileRouteSource): boolean =>
  source === scope || source === `${scope}-invalid`;

/** What a set holds: `all built-in`, `2 profiles set here, rest built-in`, or `all 7 set here`. */
const setContents = (
  scope: SubagentConfigScope,
  sources: ReadonlyArray<ProfileRouteSource>,
): string => {
  const inherited = Arr.dedupe(
    Arr.filterMap(sources, (source) =>
      ownSource(scope, source) ? Result.failVoid : Result.succeed(profileSourceLabel(source)),
    ),
  );
  const own = Arr.filter(sources, (source) => ownSource(scope, source)).length;
  const rest = inherited.length === 1 ? (inherited[0] ?? "inherited") : "inherited";
  if (own === 0) return `all ${rest}`;
  if (inherited.length === 0) return "all profiles set here";
  return `${countLabel(own, "profile")} set here, rest ${rest}`;
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
      const scopeDefault = decoded.file.defaultProfileSet === name;
      const origin = inspection.session.baseline.origin;
      const inUse = origin.scope === scope && origin.name === name;
      const status = Arr.filter(
        [
          scopeDefault ? "default for new sessions" : undefined,
          inUse ? "in use" : undefined,
          invalid
            ? repairable
              ? `${countLabel(invalidProfileCount, "invalid profile")}, fix before use`
              : "invalid structure, delete and create a new set"
            : profileSet
              ? setContents(
                  scope,
                  Arr.map(PROFILE_IDS, (id) => resolved.profileSources[id]),
                )
              : undefined,
        ],
        Predicate.isNotUndefined,
      );
      return {
        kind: "set",
        key: `${scope}:${name}`,
        scope,
        ref: { scope, name },
        scopeDefault,
        inUse,
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
  label: `No ${Str.toLowerCase(SCOPE_LABELS[scope])} sets saved`,
  description: "Save the current session here to add one",
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

/** A saved set, or a repair row for an invalid default: the entries a reader can select. */
export type SelectableProfileSetEntry = Exclude<
  ProfileSetPickerEntry,
  { readonly kind: "scope-note" }
>;

export const isSelectableProfileSetEntry = (
  entry: ProfileSetPickerEntry,
): entry is SelectableProfileSetEntry => entry.kind !== "scope-note";

/** The default set, else the first, among selectable `entries`. */
export const initialProfileSetPickerIndex = (entries: ReadonlyArray<SelectableProfileSetEntry>) =>
  Option.getOrElse(
    Arr.findFirstIndex(entries, (entry) => entry.scopeDefault),
    () => 0,
  );

export const qualifiedProfileSetLabel = (ref: PersistentProfileSetRef): string =>
  `${SCOPE_LABELS[ref.scope]}/${ref.name}`;
