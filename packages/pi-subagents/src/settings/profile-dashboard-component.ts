import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable } from "@earendil-works/pi-tui";
import { FullScreenKeymap } from "pi-cosmic-ui/manager/keymap";
import { isProjectTrusted } from "pi-cosmic-core";
import type { FleetManagerActions } from "./controller.ts";
import { ProfileEditVisit } from "./profile-edit-visit.ts";
import { ProfileWorkspaceComponent, type ProfileWorkspaceOptions } from "./profile-workspace.ts";
import {
  profileTargetKey as keyFor,
  type ProfileSettingsInspection,
  type ProfileWorkspaceTarget,
} from "./profile-route-editor.ts";
import { ProfileSetPickerComponent, type ProfileSetPickerAction } from "./profile-set-picker.ts";
import { ProfileDashboardDialog } from "./profile-dashboard-dialogs.ts";
import { runProfileSetAction, type ProfileSetSaveDestination } from "./profile-set-actions.ts";
import {
  profileDashboardChildHeight,
  renderProfileDashboard,
} from "./ui/profile-dashboard-render.ts";
import { profileSetPickerEntries } from "./ui/profile-set-picker-model.ts";
import { withoutNavigationKeys } from "./ui/profile-workspace-keys.ts";

type Child = Component & { focused?: boolean; dispose?: () => void };

export interface ProfileDashboardOptions {
  readonly workspace: ProfileWorkspaceOptions;
  readonly ctx: ExtensionCommandContext;
  readonly actions: FleetManagerActions;
  readonly isCurrent: () => boolean;
  readonly onInspection: (inspection: ProfileSettingsInspection) => void;
  readonly awaitDialog: <T>(register: (finish: (value: T) => void) => () => void) => Promise<T>;
  readonly onDispose?: (() => void) | undefined;
}

/** One host slot owns every editor, library page and transient dialog. */
export class ProfileDashboardComponent implements Component, Focusable {
  private readonly keymap = new FullScreenKeymap();
  private inspection: ProfileSettingsInspection;
  private readonly visit: ProfileEditVisit;
  private readonly editors = new Map<string, ProfileWorkspaceComponent>();
  private renaming: string | undefined;
  private readonly library: ProfileSetPickerComponent;
  private tab: "session" | "saved" = "session";
  private savedTarget: ProfileWorkspaceTarget | undefined;
  private overlay: Child | undefined;
  private cancelDialog: (() => void) | undefined;
  private busy = false;
  private blocked = false;
  private disposed = false;
  private _focused = false;
  private message = "";

  private readonly options: ProfileDashboardOptions;
  constructor(options: ProfileDashboardOptions) {
    this.options = options;
    this.inspection = options.workspace.inspection;
    this.visit = new ProfileEditVisit(this.inspection);
    this.library = new ProfileSetPickerComponent({
      ...this.host(),
      inspection: this.inspection,
      projectTrusted: isProjectTrusted(options.ctx),
      close: (action) => {
        if (!this.current()) return;
        if (!action) this.options.workspace.close();
        else this.act(action);
      },
    });
    this.editor({ kind: "session" });
  }
  private current = (): boolean => {
    if (this.disposed) return false;
    if (this.options.isCurrent()) return true;
    this.dispose();
    this.options.workspace.close();
    return false;
  };
  private renderSoon = (): void => {
    if (this.current()) this.options.workspace.requestRender();
  };
  private host(framed = true) {
    return {
      ...this.options.workspace,
      getHeight: () => profileDashboardChildHeight(this.options.workspace.getHeight(), framed),
      requestRender: this.renderSoon,
    };
  }
  private publish(inspection: ProfileSettingsInspection): void {
    if (!this.current()) return;
    this.inspection = inspection;
    this.options.onInspection(inspection);
    this.library.updateInspection(inspection, isProjectTrusted(this.options.ctx));
    this.reconcileTargets();
    // Owned rename transfers checkpoints before reconciling the vanished old name.
    // Input stays blocked until that transfer and the final publish finish.
    if (!this.renaming) {
      this.visit.reconcile(inspection);
      for (const editor of this.editors.values()) editor.updateInspection(inspection);
    }
    this.renderSoon();
  }
  private reconcileTargets(): void {
    const entries = profileSetPickerEntries(this.inspection, isProjectTrusted(this.options.ctx));
    for (const [key, { target }] of this.editors) {
      if (target.kind === "session" || key === this.renaming) continue;
      const entry = entries.find(
        (candidate) =>
          candidate.kind === "set" &&
          candidate.scope === target.set.scope &&
          candidate.ref.name === target.set.name,
      );
      if (entry?.kind === "set" && (!entry.invalid || entry.repairable)) continue;
      this.visit.deleteTarget(target);
      this.retire(target);
    }
  }
  /** Drops a target's cached editor; a saved selection follows it to `replacement` or clears. */
  private retire(target: ProfileWorkspaceTarget, replacement?: ProfileWorkspaceTarget): void {
    const key = keyFor(target);
    this.editors.get(key)?.dispose();
    this.editors.delete(key);
    if (this.savedTarget && keyFor(this.savedTarget) === key) this.savedTarget = replacement;
  }
  private editor(
    target: ProfileWorkspaceTarget,
    position?: ReturnType<ProfileWorkspaceComponent["getPosition"]>,
  ): ProfileWorkspaceComponent {
    const key = keyFor(target);
    const existing = this.editors.get(key);
    if (existing) {
      existing.updateInspection(this.inspection);
      return existing;
    }
    this.visit.captureTarget(target, this.inspection);
    const workspace = this.host();
    const editor = new ProfileWorkspaceComponent({
      ...workspace,
      ...position,
      target,
      inspection: this.inspection,
      editVisit: this.visit,
      saveDraft: (editorTarget, profile, draft, restore) => {
        if (!this.current() || this.blocked)
          return Promise.reject(new Error("Close and reopen the profile dashboard."));
        return workspace.saveDraft(editorTarget, profile, draft, restore).then((result) => {
          if (this.current() && "refreshError" in result) {
            this.blocked = true;
            this.message = result.refreshError;
          }
          return result;
        });
      },
      onInspection: (inspection) => this.publish(inspection),
      close: () => this.editorClosed(target),
      saveSession: () => this.act({ action: "save-session" }),
    });
    this.editors.set(key, editor);
    return editor;
  }
  private editorClosed(target: ProfileWorkspaceTarget): void {
    if (!this.current()) return;
    if (target.kind === "session") {
      this.options.workspace.close();
      return;
    }
    this.savedTarget = undefined;
    this.focused = this._focused;
    this.renderSoon();
  }
  private child(): Child {
    if (this.overlay) return this.overlay;
    if (this.tab === "saved" && !this.savedTarget) return this.library;
    return this.editors.get(
      keyFor(this.tab === "session" ? { kind: "session" } : this.savedTarget!),
    )!;
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    for (const editor of this.editors.values()) editor.focused = false;
    if (this.overlay) this.overlay.focused = false;
    this.child().focused = value;
  }
  private dialog<T>(
    make: (close: (value: T | undefined) => void) => Child,
  ): Promise<T | undefined> {
    if (!this.current()) return Promise.resolve(undefined);
    return this.options.awaitDialog<T | undefined>((resolve) => {
      const close = (value: T | undefined): void => {
        if (this.cancelDialog !== cancel) return;
        this.overlay?.dispose?.();
        this.overlay = undefined;
        this.cancelDialog = undefined;
        resolve(value);
        if (this.current()) {
          this.focused = this._focused;
          this.renderSoon();
        }
      };
      const cancel = () => close(undefined);
      this.cancelDialog = cancel;
      this.overlay = make(close);
      this.focused = this._focused;
      this.renderSoon();
      return cancel;
    });
  }
  private refresh(): Promise<ProfileSettingsInspection> {
    if (!this.current()) return Promise.reject(new Error("Profile dashboard closed."));
    return this.options.actions
      .inspectProfiles(isProjectTrusted(this.options.ctx))
      .then((next) => {
        if (!this.current()) throw new Error("Profile dashboard closed.");
        this.publish(next);
        return next;
      })
      .catch((error) => {
        if (this.current()) this.blocked = true;
        throw error;
      });
  }
  private act(action: ProfileSetPickerAction): void {
    if (!this.current() || this.busy || this.blocked) return;
    if (action.action === "save-session" && this.tab !== "session") return;
    if (action.action === "edit") {
      if (action.target.scope === "project" && !isProjectTrusted(this.options.ctx)) return;
      this.savedTarget = { kind: "profile-set", set: action.target };
      this.editor(this.savedTarget);
      this.focused = this._focused;
      this.renderSoon();
      return;
    }
    this.busy = true;
    this.message = "";
    this.renaming =
      action.action === "rename" ? keyFor({ kind: "profile-set", set: action.target }) : undefined;
    void runProfileSetAction(
      {
        actions: this.options.actions,
        inspection: () => this.inspection,
        isCurrent: this.current,
        trusted: () => isProjectTrusted(this.options.ctx),
        refresh: () => this.refresh(),
        confirm: (title, body) =>
          this.dialog<boolean>(
            (close) =>
              new ProfileDashboardDialog({
                ...this.host(false),
                title,
                body,
                kind: "confirm",
                close,
              }),
          ).then((value) => value === true),
        name: (title, initial) =>
          this.dialog<string>(
            (close) =>
              new ProfileDashboardDialog({
                ...this.host(false),
                title,
                initial,
                kind: "name",
                close,
              }),
          ),
        save: () =>
          this.dialog<ProfileSetSaveDestination>(
            (close) =>
              new ProfileDashboardDialog({
                ...this.host(false),
                title: "Save these profiles as a set",
                body: "Copies all seven Current Session profiles. Does not apply the set or change the default.",
                kind: "name",
                destination: { projectTrusted: isProjectTrusted(this.options.ctx) },
                close,
              }),
          ),
        used: (baseline, latest) => {
          this.visit.resetSession(baseline);
          this.visit.reconcile(latest);
          this.tab = "session";
          this.editor({ kind: "session" });
        },
        notify: (message) => {
          if (this.current()) this.message = message;
        },
        renamed: (previous, next, inspection) => {
          this.visit.renameTarget(previous, next, inspection);
          // Fixed-target editors cannot be retargeted. Preserve their position when replacing the renamed cache entry.
          const position = this.editors.get(keyFor(previous))?.getPosition();
          this.retire(previous, next);
          if (position) this.editor(next, position);
        },
        deleted: (target) => {
          this.visit.deleteTarget(target);
          this.retire(target);
        },
      },
      action,
    )
      .catch((error) => {
        if (!this.current()) return;
        this.message = error instanceof Error ? error.message : "Could not update profiles.";
        return this.refresh().then(
          (inspection) => {
            if (this.current()) this.visit.reconcile(inspection);
          },
          () => {
            if (this.current())
              this.message = "Could not refresh profiles. Close and reopen the dashboard.";
          },
        );
      })
      .finally(() => {
        if (this.current()) {
          this.renaming = undefined;
          this.publish(this.inspection);
          this.busy = false;
          this.focused = this._focused;
          this.renderSoon();
        }
      });
    this.renderSoon();
  }
  /** Dialogs, pickers, menus, and in-flight edits own their input. */
  private ownsInput(child: Child): boolean {
    if (child === this.overlay) return true;
    if (child === this.library) return this.library.hasOverlay;
    return child instanceof ProfileWorkspaceComponent && (child.hasOverlay || child.isBusy);
  }
  handleInput(data: string): void {
    if (!this.current()) return;
    const child = this.child();
    if (this.ownsInput(child)) {
      child.handleInput?.(data);
      return;
    }
    if (this.busy) return;
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: withoutNavigationKeys(this.options.workspace.matchesKeybinding),
      reservedKeys: new Set(["s"]),
    });
    const action = resolution?._tag === "Action" ? resolution.action : undefined;
    if (this.blocked) {
      if (action === "cancel" || action === "quit") this.options.workspace.close();
      return;
    }
    if (action === "next-pane" || action === "previous-pane") this.switchTab();
    // Saving Current Session is not a library action.
    else if (!(this.tab === "saved" && resolution?._tag === "Shortcut")) child.handleInput?.(data);
    this.focused = this._focused;
    this.renderSoon();
  }
  private switchTab(): void {
    this.reconcileTargets();
    this.library.updateInspection(this.inspection, isProjectTrusted(this.options.ctx));
    this.tab = this.tab === "session" ? "saved" : "session";
    if (this.tab === "session") this.editor({ kind: "session" });
    else if (this.savedTarget) this.editor(this.savedTarget);
  }
  render(width: number): string[] {
    if (!this.current()) return [];
    const child = this.child();
    const framedChild = !(child instanceof ProfileDashboardDialog);
    return renderProfileDashboard(
      {
        tab: this.tab,
        message: this.message,
        blocked: this.blocked,
        busy: this.busy && !this.overlay,
        rows: child.render(framedChild ? width : Math.max(0, width - 2)),
        framedChild,
      },
      { theme: this.options.workspace.theme, width, height: this.options.workspace.getHeight() },
    );
  }
  invalidate(): void {
    for (const editor of this.editors.values()) editor.invalidate();
    this.library.invalidate();
    this.overlay?.invalidate();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelDialog?.();
    for (const editor of this.editors.values()) editor.dispose();
    this.library.dispose();
    this.options.onDispose?.();
  }
}
