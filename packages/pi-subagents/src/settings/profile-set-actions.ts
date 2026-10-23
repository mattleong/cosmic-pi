import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { FleetManagerActions } from "./controller.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import {
  resolvedSet,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import type { ProfileSetPickerAction } from "./profile-set-picker.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";

export interface ProfileSetSaveDestination {
  readonly scope: "global" | "project";
  readonly name: string;
}
export interface ProfileSetActionHost {
  readonly actions: FleetManagerActions;
  readonly inspection: () => ProfileSettingsInspection;
  readonly isCurrent: () => boolean;
  readonly trusted: () => boolean;
  readonly refresh: () => Promise<ProfileSettingsInspection>;
  readonly confirm: (title: string, body: string) => Promise<boolean>;
  readonly name: (title: string, initial: string) => Promise<string | undefined>;
  readonly save: () => Promise<ProfileSetSaveDestination | undefined>;
  readonly used: (baseline: ProfileSettingsInspection, latest: ProfileSettingsInspection) => void;
  readonly renamed: (
    previous: ProfileWorkspaceTarget,
    next: ProfileWorkspaceTarget,
    inspection: ProfileSettingsInspection,
  ) => void;
  readonly deleted: (target: ProfileWorkspaceTarget) => void;
  readonly notify: (message: string) => void;
}
const invalidSession = (inspection: ProfileSettingsInspection): boolean =>
  Arr.some(PROFILE_IDS, (profile) =>
    ["global-invalid", "project-invalid"].includes(
      inspection.session.effectiveConfig.profileSources[profile],
    ),
  );

type PersistentAction = Exclude<
  ProfileSetPickerAction,
  { readonly action: "edit" } | { readonly action: "save-session" }
>;
type Scope = "global" | "project";

interface ActionRun {
  readonly host: ProfileSetActionHost;
  readonly inspection: ProfileSettingsInspection;
  readonly guard: (scope?: Scope) => void;
  readonly finish: (
    message: string,
    apply?: (latest: ProfileSettingsInspection) => void,
  ) => Promise<void>;
}

interface ScopedActionRun extends ActionRun {
  readonly scope: Scope;
  readonly base: () => ReturnType<typeof profileSetPatchBase>;
}

const startActionRun = (host: ProfileSetActionHost): ActionRun => {
  const guard = (scope?: Scope): void => {
    if (!host.isCurrent()) throw new Error("This profile dashboard is no longer active.");
    if (scope === "project" && !host.trusted())
      throw new Error("Trust this project before changing or using its saved profiles.");
  };
  const finish = (message: string, apply?: (latest: ProfileSettingsInspection) => void) => {
    guard();
    return host.refresh().then((latest) => {
      guard();
      apply?.(latest);
      host.notify(message);
      return undefined;
    });
  };
  guard();
  return { host, inspection: host.inspection(), guard, finish };
};

const saveSession = ({ host, inspection, guard, finish }: ActionRun): Promise<void> => {
  if (invalidSession(inspection))
    throw new Error("Fix or disable invalid Current Session profiles before saving a set.");
  return host.save().then((destination) => {
    guard();
    if (!destination) return undefined;
    return host.refresh().then((latest) => {
      guard(destination.scope);
      if (latest.session.revision !== inspection.session.revision)
        throw new Error("Current Session changed. Review the profiles and save again.");
      if (invalidSession(latest))
        throw new Error("Fix or disable invalid Current Session profiles before saving a set.");
      return host.actions
        .createProfileSetFromSnapshot({
          ...profileSetPatchBase(latest, destination.scope, host.trusted()),
          profileSet: destination.name,
          expectedRevision: inspection.session.revision,
        })
        .then(() =>
          finish(
            `Saved Current Session as ${destination.scope}/${destination.name}. Default unchanged.`,
          ),
        );
    });
  });
};

const useSet = (
  run: ScopedActionRun,
  action: Extract<PersistentAction, { readonly action: "use-current" | "make-default" }>,
): Promise<void> => {
  const { host, inspection, guard, finish, scope, base } = run;
  const resolved = resolvedSet(inspection, action.target);
  if (resolved.status !== "resolved" || resolved.invalidProfiles.length > 0)
    throw new Error("Fix this invalid saved set before using it or making it default.");
  if (action.action === "use-current") {
    const preview = Fn.pipe(
      PROFILE_IDS,
      Arr.map(
        (profile) =>
          `${profile}: ${
            Fn.pipe(
              resolved.profiles[profile].candidates,
              Arr.map(
                (candidate) =>
                  `local/${candidate.runtime} ${candidate.model}${candidate.openaiFastMode ? " ⚡" : ""} · ${candidate.effort}`,
              ),
              Arr.join(" → "),
            ) || "disabled"
          }`,
      ),
      Arr.join("\n"),
    );
    return host
      .confirm(
        `Use ${scope}/${action.target.name} in Current Session?`,
        `Replace all seven profiles. Active runs stay unchanged. Later edits remain separate.\n\n${preview}`,
      )
      .then((confirmed) => {
        guard(scope);
        if (!confirmed) return undefined;
        return host.actions
          .replaceSessionProfiles({
            origin: resolved.origin,
            profiles: resolved.profiles,
            profileSources: resolved.profileSources,
            expectedRevision: inspection.session.revision,
          })
          .then((snapshot) =>
            finish(
              `Copied ${scope}/${action.target.name} into Current Session. Active runs unchanged.`,
              (latest) => host.used({ ...latest, session: snapshot }, latest),
            ),
          );
      });
  }
  return host.refresh().then((latest) => {
    guard(scope);
    const valid = resolvedSet(latest, action.target);
    if (valid.status !== "resolved" || valid.invalidProfiles.length > 0)
      throw new Error("Fix this invalid saved set before making it default.");
    return host.actions
      .patchDefaultProfileSet({ ...base(), defaultProfileSet: action.target.name })
      .then(() => finish(`Default updated for ${scope}. Current Session unchanged.`));
  });
};

const nameSet = (
  { host, guard, finish, scope, base }: ScopedActionRun,
  action: Extract<PersistentAction, { readonly action: "copy" | "rename" }>,
): Promise<void> => {
  const source = action.action === "copy" ? action.source : action.target;
  return host
    .name(
      `${action.action === "copy" ? "Duplicate" : "Rename"} ${scope}/${source.name}`,
      action.action === "copy" ? `${source.name} copy` : source.name,
    )
    .then((name) => {
      guard(scope);
      if (!name) return undefined;
      if (action.action === "copy")
        return host.actions
          .copyProfileSet({ ...base(), sourceProfileSet: source.name, profileSet: name })
          .then(() => finish(`Created ${scope}/${name}. Current Session unchanged.`));
      return host.actions
        .renameProfileSet({ ...base(), profileSet: source.name, nextProfileSet: name })
        .then(() =>
          finish(`Renamed ${scope}/${name}. Current Session unchanged.`, (latest) =>
            host.renamed(
              { kind: "profile-set", set: source },
              { kind: "profile-set", set: { ...source, name } },
              latest,
            ),
          ),
        );
    });
};

const deleteSet = (
  { host, guard, finish, scope, base }: ScopedActionRun,
  action: Extract<PersistentAction, { readonly action: "delete" }>,
): Promise<void> =>
  host
    .confirm(
      `Delete ${scope}/${action.target.name}?`,
      "This deletes the saved set. Current Session will not change.",
    )
    .then((confirmed) => {
      guard(scope);
      if (!confirmed) {
        host.notify("Delete cancelled");
        return undefined;
      }
      return host.actions
        .deleteProfileSet({ ...base(), profileSet: action.target.name })
        .then(() => {
          guard();
          host.deleted({ kind: "profile-set", set: action.target });
          return finish(`Deleted ${scope}/${action.target.name}. Current Session unchanged.`);
        });
    });

const actionScope = (action: PersistentAction): Scope => {
  switch (action.action) {
    case "clear-scope-default":
      return action.scope;
    case "copy":
      return action.source.scope;
    case "use-current":
    case "make-default":
    case "rename":
    case "delete":
      return action.target.scope;
  }
  return Fn.absurd(action);
};

const runPersistentAction = (run: ActionRun, action: PersistentAction): Promise<void> => {
  const scope = actionScope(action);
  run.guard(scope);
  const scoped: ScopedActionRun = {
    ...run,
    scope,
    base: () => profileSetPatchBase(run.inspection, scope, run.host.trusted()),
  };
  switch (action.action) {
    case "use-current":
    case "make-default":
      return useSet(scoped, action);
    case "clear-scope-default":
      return run.host.actions
        .patchDefaultProfileSet(scoped.base())
        .then(() => run.finish(`${scope} default cleared. Current Session unchanged.`));
    case "copy":
    case "rename":
      return nameSet(scoped, action);
    case "delete":
      return deleteSet(scoped, action);
  }
  return Fn.absurd(action);
};

export function runProfileSetAction(
  host: ProfileSetActionHost,
  action: ProfileSetPickerAction,
): Promise<void> {
  return Promise.resolve().then(() => {
    const run = startActionRun(host);
    if (action.action === "edit") return undefined;
    if (action.action === "save-session") return saveSession(run);
    return runPersistentAction(run, action);
  });
}
