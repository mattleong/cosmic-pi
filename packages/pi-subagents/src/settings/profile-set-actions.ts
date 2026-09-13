// Promise-shaped continuations belong to the single dashboard host lifetime.
import type { FleetManagerActions } from "./controller.ts";
import { resolveNamedProfileSet } from "../config/options.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import type { ProfileSettingsInspection, ProfileWorkspaceTarget } from "./profile-route-editor.ts";
import type { ProfileSetPickerAction } from "./profile-set-picker.ts";
import type { ProfileSetSaveDestination } from "./profile-set-save-form.ts";
import { profileSetPatchBase } from "./profile-write-context.ts";

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
  PROFILE_IDS.some((profile) =>
    ["global-invalid", "project-invalid"].includes(
      inspection.session.effectiveConfig.profileSources[profile],
    ),
  );

/** Each action captures the displayed revision and exact document before any dialog. */
export function runProfileSetAction(
  host: ProfileSetActionHost,
  action: ProfileSetPickerAction,
): Promise<void> {
  return Promise.resolve().then(() => {
    const guard = (scope?: "global" | "project"): void => {
      if (!host.isCurrent()) throw new Error("This profile dashboard is no longer active.");
      if (scope === "project" && !host.trusted())
        throw new Error("Trust this project before changing or using its saved profiles.");
    };
    const finish = (message: string): Promise<void> => {
      guard();
      return host.refresh().then(() => {
        guard();
        host.notify(message);
      });
    };
    guard();
    const inspection = host.inspection();
    if (action.action === "edit") return;
    if (action.action === "save-session") {
      if (invalidSession(inspection))
        throw new Error("Fix or disable invalid Current Session profiles before saving a set.");
      return host.save().then((destination) => {
        guard();
        if (!destination) return;
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
    }
    const target =
      action.action === "copy"
        ? action.source
        : action.action === "clear-scope-default"
          ? undefined
          : action.target;
    const scope = action.action === "clear-scope-default" ? action.scope : target!.scope;
    guard(scope);
    const base = profileSetPatchBase(inspection, scope, host.trusted());
    if (action.action === "use-current" || action.action === "make-default") {
      const input = { scope, name: action.target.name, global: inspection.global };
      const resolved = resolveNamedProfileSet(
        inspection.project ? { ...input, project: inspection.project } : input,
      );
      if (resolved.status !== "resolved" || resolved.invalidProfiles.length > 0)
        throw new Error("Fix this invalid saved set before using it or making it default.");
      if (action.action === "use-current") {
        const preview = PROFILE_IDS.map(
          (profile) =>
            `${profile}: ${resolved.profiles[profile].candidates.map((candidate) => `${candidate.host}/${candidate.runtime} ${candidate.model} · ${candidate.effort}`).join(" → ") || "disabled"}`,
        ).join("\n");
        return host
          .confirm(
            `Use ${scope}/${action.target.name} in Current Session?`,
            `Replace all seven profiles. Active runs stay unchanged. Later edits remain separate.\n\n${preview}`,
          )
          .then((confirmed) => {
            guard(scope);
            if (!confirmed) return;
            const patch = {
              origin: resolved.origin,
              profiles: resolved.profiles,
              profileSources: resolved.profileSources,
              expectedRevision: inspection.session.revision,
            };
            const commit = host.actions.replaceSessionProfilesWithReceipt
              ? host.actions.replaceSessionProfilesWithReceipt(patch)
              : host.actions.replaceSessionProfiles(patch).then(() => undefined);
            return commit.then((snapshot) => {
              guard();
              return host.refresh().then((next) => {
                guard();
                host.used(snapshot ? { ...next, session: snapshot } : next, next);
                host.notify(
                  `Copied ${scope}/${action.target.name} into Current Session. Active runs unchanged.`,
                );
              });
            });
          });
      }
      return host.refresh().then((latest) => {
        guard(scope);
        const latestInput = { scope, name: action.target.name, global: latest.global };
        const valid = resolveNamedProfileSet(
          latest.project ? { ...latestInput, project: latest.project } : latestInput,
        );
        if (valid.status !== "resolved" || valid.invalidProfiles.length > 0)
          throw new Error("Fix this invalid saved set before making it default.");
        return host.actions
          .patchDefaultProfileSet({
            ...base,
            projectTrusted: host.trusted(),
            defaultProfileSet: action.target.name,
          })
          .then(() => finish(`Default updated for ${scope}. Current Session unchanged.`));
      });
    }
    if (action.action === "clear-scope-default")
      return host.actions
        .patchDefaultProfileSet(base)
        .then(() => finish(`${scope} default cleared. Current Session unchanged.`));
    if (action.action === "copy" || action.action === "rename") {
      const source = action.action === "copy" ? action.source : action.target;
      return host
        .name(
          `${action.action === "copy" ? "Duplicate" : "Rename"} ${scope}/${source.name}`,
          action.action === "copy" ? `${source.name} copy` : source.name,
        )
        .then((name) => {
          guard(scope);
          if (!name) return;
          if (action.action === "copy")
            return host.actions
              .copyProfileSet({
                ...base,
                projectTrusted: host.trusted(),
                sourceProfileSet: source.name,
                profileSet: name,
              })
              .then(() => finish(`Created ${scope}/${name}. Current Session unchanged.`));
          return host.actions
            .renameProfileSet({
              ...base,
              projectTrusted: host.trusted(),
              profileSet: source.name,
              nextProfileSet: name,
            })
            .then(() => {
              guard();
              return host.refresh().then((next) => {
                guard();
                host.renamed(
                  { kind: "profile-set", set: source },
                  { kind: "profile-set", set: { ...source, name } },
                  next,
                );
                host.notify(`Renamed ${scope}/${name}. Current Session unchanged.`);
              });
            });
        });
    }
    return host.actions.deleteProfileSet({ ...base, profileSet: action.target.name }).then(() => {
      guard();
      host.deleted({ kind: "profile-set", set: action.target });
      return finish(`Deleted ${scope}/${action.target.name}. Current Session unchanged.`);
    });
  });
}
