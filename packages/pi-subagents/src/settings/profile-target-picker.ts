import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  SearchableSelectPage,
  type SearchableSelectHostOptions,
  type SearchableSelectPageChoice,
} from "pi-cosmic-ui/manager/searchable-select";
import type { ProfileSettingsInspection, ProfileWorkspaceTarget } from "./profile-route-editor.ts";
import {
  profileSetPickerEntries,
  qualifiedProfileSetLabel,
} from "./ui/profile-set-picker-model.ts";

export interface ProfileTargetPickerOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly inspection: ProfileSettingsInspection;
  readonly projectTrusted: boolean;
  readonly target: ProfileWorkspaceTarget;
  readonly close: (target: ProfileWorkspaceTarget | undefined) => void;
}

/** Target choice only. Persistence and trust rechecks remain in the dashboard. */
export class ProfileTargetPickerComponent extends SearchableSelectPage<ProfileWorkspaceTarget> {
  constructor(options: ProfileTargetPickerOptions) {
    const choices: Array<SearchableSelectPageChoice<ProfileWorkspaceTarget>> = [
      {
        value: "session",
        item: { value: "session", label: "Current Session" },
        searchText: "Current Session",
        payload: { kind: "session" },
      },
    ];
    for (const entry of profileSetPickerEntries(options.inspection, options.projectTrusted)) {
      const label = entry.kind === "set" ? qualifiedProfileSetLabel(entry.ref) : entry.label;
      choices.push({
        value: entry.key,
        item: { value: entry.key, label, description: entry.description },
        searchText: `${label} ${entry.scope}`,
        payload:
          entry.kind === "set" ? { kind: "profile-set", set: entry.ref } : { kind: "session" },
        enabled: entry.kind === "set" && (!entry.invalid || entry.repairable),
        disabledReason: entry.description,
      });
    }
    super({
      ...options,
      breadcrumb: "Subagent profiles",
      title: "Editing target",
      subtitle: "Current Session · Project saved sets · Global saved sets",
      choices,
      current:
        options.target.kind === "session"
          ? "session"
          : `${options.target.set.scope}:${options.target.set.name}`,
      select: options.close,
      cancel: () => options.close(undefined),
    });
  }
}
