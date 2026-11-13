import * as Predicate from "effect/Predicate";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { FullScreenKeymap } from "pi-cosmic-ui/manager/keymap";
import { joinInline } from "pi-cosmic-ui/manager";
import { isProjectTrusted } from "pi-cosmic-core/host-session";
import type { SubagentCommandActions } from "./controller.ts";
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
  profileDashboardContext,
  profileDashboardStatusLines,
  profileDashboardTextWidth,
  renderProfileDashboard,
  type DashboardStatus,
} from "./ui/profile-dashboard-render.ts";
import { profileSetPickerEntries } from "./ui/profile-set-picker-model.ts";
import { withoutNavigationKeys } from "./ui/profile-workspace-keys.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

type Pane = ProfileWorkspaceComponent | ProfileSetPickerComponent;

interface ProfileDashboardOptions {
  readonly workspace: ProfileWorkspaceOptions;
  readonly ctx: ExtensionCommandContext;
  readonly actions: SubagentCommandActions;
  readonly isCurrent: () => boolean;
  readonly onInspection: (inspection: ProfileSettingsInspection) => void;
  readonly awaitDialog: <T>(register: (finish: (value: T) => void) => () => void) => Promise<T>;
  readonly onDispose?: (() => void) | undefined;
}

export class ProfileDashboardComponent implements Component, Focusable {
  private readonly keymap = new FullScreenKeymap();
  private inspection: ProfileSettingsInspection;
  private readonly visit: ProfileEditVisit;
  private readonly editors = new Map<string, ProfileWorkspaceComponent>();
  private renaming: string | undefined;
  private readonly library: ProfileSetPickerComponent;
  private tab: "session" | "saved" = "session";
  private savedTarget: ProfileWorkspaceTarget | undefined;
  private overlay: ProfileDashboardDialog | undefined;
  private cancelDialog: (() => void) | undefined;
  private busy = false;
  private blocked = false;
  private disposed = false;
  private focusState = false;
  private message: DashboardStatus | undefined;
  // Rows the status row takes; the current pane gets the rest below the top border.
  private statusRows = 1;

  private readonly options: ProfileDashboardOptions;
  constructor(options: ProfileDashboardOptions) {
    this.options = options;
    this.inspection = options.workspace.inspection;
    this.visit = new ProfileEditVisit(this.inspection);
    this.library = new ProfileSetPickerComponent({
      ...this.host(),
      inspection: this.inspection,
      projectTrusted: isProjectTrusted(options.ctx),
      parentModel: options.workspace.parentModel,
      parentEffort: options.workspace.parentEffort,
      close: (action) => {
        if (!this.current()) return;
        if (!action) this.options.workspace.close();
        else this.act(action);
      },
    });
    this.editor({ kind: "session" });
  }
  private readonly current = (): boolean => {
    if (this.disposed) return false;
    if (this.options.isCurrent()) return true;
    this.dispose();
    this.options.workspace.close();
    return false;
  };
  private readonly renderSoon = (): void => {
    if (this.current()) this.options.workspace.requestRender();
  };
  private host() {
    return {
      ...this.options.workspace,
      getHeight: () => Math.max(0, this.options.workspace.getHeight() - 1 - this.statusRows),
      getFrameHeight: () => this.options.workspace.getHeight(),
      requestRender: this.renderSoon,
    };
  }
  private publish(inspection: ProfileSettingsInspection): void {
    if (!this.current()) return;
    this.inspection = inspection;
    this.options.onInspection(inspection);
    this.library.updateInspection(inspection, isProjectTrusted(this.options.ctx));
    this.reconcileTargets();
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
      const entry = findOrUndefined(
        entries,
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
            this.message = { kind: "error", text: result.refreshError };
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
    this.focused = this.focusState;
    this.renderSoon();
  }
  /** The pane the current tab shows: the session editor, a saved set's editor, or the library. */
  private pane(): Pane {
    const target: ProfileWorkspaceTarget | undefined =
      this.tab === "session" ? { kind: "session" } : this.savedTarget;
    return (target && this.editors.get(keyFor(target))) ?? this.library;
  }
  get focused(): boolean {
    return this.focusState;
  }
  set focused(value: boolean) {
    this.focusState = value;
    for (const editor of this.editors.values()) editor.focused = false;
    this.library.focused = false;
    if (this.overlay) this.overlay.focused = value;
    else this.pane().focused = value;
  }
  private dialog<T>(
    make: (close: (value: T | undefined) => void) => ProfileDashboardDialog,
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
          this.focused = this.focusState;
          this.renderSoon();
        }
      };
      const cancel = () => close(undefined);
      this.cancelDialog = cancel;
      this.overlay = make(close);
      this.focused = this.focusState;
      this.renderSoon();
      return cancel;
    });
  }
  private refresh(): Promise<ProfileSettingsInspection> {
    if (!this.current()) return Promise.reject(new Error("Profile dashboard closed."));
    return this.options.actions
      .inspectProfiles(isProjectTrusted(this.options.ctx))
      .then((latest) => {
        if (!this.current()) throw new Error("Profile dashboard closed.");
        this.publish(latest);
        return latest;
      })
      .catch((cause: unknown) => {
        if (this.current()) this.blocked = true;
        throw cause;
      });
  }
  private act(action: ProfileSetPickerAction): void {
    if (!this.current() || this.busy || this.blocked) return;
    if (action.action === "save-session" && this.tab !== "session") return;
    if (action.action === "edit") {
      if (action.target.scope === "project" && !isProjectTrusted(this.options.ctx)) return;
      this.savedTarget = { kind: "profile-set", set: action.target };
      this.editor(this.savedTarget);
      this.focused = this.focusState;
      this.renderSoon();
      return;
    }
    this.busy = true;
    this.message = undefined;
    this.renaming =
      action.action === "rename" ? keyFor({ kind: "profile-set", set: action.target }) : undefined;
    void runProfileSetAction(
      {
        actions: this.options.actions,
        inspection: () => this.inspection,
        isCurrent: this.current,
        trusted: () => isProjectTrusted(this.options.ctx),
        refresh: () => this.refresh(),
        confirm: (title, body, verb) =>
          this.dialog<boolean>(
            (close) =>
              new ProfileDashboardDialog({
                ...this.host(),
                title,
                body,
                verb,
                kind: "confirm",
                close,
              }),
          ).then((value) => value === true),
        name: (title, initial, verb) =>
          this.dialog<string>(
            (close) =>
              new ProfileDashboardDialog({
                ...this.host(),
                title,
                initial,
                verb,
                kind: "name",
                close,
              }),
          ),
        save: () =>
          this.dialog<ProfileSetSaveDestination>(
            (close) =>
              new ProfileDashboardDialog({
                ...this.host(),
                title: "Save the session's profiles as a set",
                body: "Copies all seven profiles. It doesn't change which set the session is based on or the default.",
                verb: "Save",
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
          if (this.current()) this.message = { kind: "success", text: message };
        },
        renamed: (previous, next, inspection) => {
          this.visit.renameTarget(previous, next, inspection);
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
      .catch((cause: unknown) => {
        if (!this.current()) return undefined;
        this.message = {
          kind: "error",
          text: cause instanceof Error ? cause.message : "Could not update profiles.",
        };
        return this.refresh().then(
          (inspection) => {
            if (this.current()) this.visit.reconcile(inspection);
            return undefined;
          },
          () => {
            if (this.current())
              this.message = {
                kind: "error",
                text: "Could not refresh profiles. Close and reopen the dashboard.",
              };
          },
        );
      })
      .finally(() => {
        if (this.current()) {
          this.renaming = undefined;
          this.publish(this.inspection);
          this.busy = false;
          this.focused = this.focusState;
          this.renderSoon();
        }
      });
    this.renderSoon();
  }
  private ownsInput(pane: Pane): boolean {
    if (pane instanceof ProfileSetPickerComponent) return pane.hasOverlay;
    return pane.hasOverlay || pane.isBusy;
  }
  handleInput(data: string): void {
    if (!this.current()) return;
    if (this.overlay) {
      this.overlay.handleInput(data);
      return;
    }
    const child = this.pane();
    if (this.ownsInput(child)) {
      child.handleInput(data);
      return;
    }
    if (this.busy) return;
    // A finished action's message gives way to the tab's context at the next key.
    if (!this.blocked) this.message = undefined;
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: withoutNavigationKeys(this.options.workspace.matchesKeybinding),
      reservedKeys: new Set(["s"]),
    });
    const action = Predicate.isTagged(resolution, "Action") ? resolution.action : undefined;
    if (this.blocked) {
      if (action === "cancel" || action === "quit") this.options.workspace.close();
      return;
    }
    this.route(child, data, action, Predicate.isTagged(resolution, "Shortcut"));
    this.focused = this.focusState;
    this.renderSoon();
  }
  private route(child: Pane, data: string, action: string | undefined, shortcut: boolean): void {
    if (action === "next-pane" || action === "previous-pane") this.switchTab();
    // `s` saves the session as a set, so it does nothing on the saved tab.
    else if (!(this.tab === "saved" && shortcut)) child.handleInput(data);
  }
  private switchTab(): void {
    this.pane().dismissStatus();
    this.reconcileTargets();
    this.library.updateInspection(this.inspection, isProjectTrusted(this.options.ctx));
    this.tab = this.tab === "session" ? "saved" : "session";
    if (this.tab === "session") this.editor({ kind: "session" });
    else if (this.savedTarget) this.editor(this.savedTarget);
    this.pane().dismissStatus();
  }
  /** The status row: a blocking or transient message, else the tab's standing context. */
  private status(width: number): DashboardStatus {
    const pane = this.pane();
    if (this.blocked)
      return this.message ?? { kind: "error", text: "Close and reopen to continue editing." };
    if (this.busy && !this.overlay) return { kind: "info", text: "Saving…" };
    const transient = this.message ?? pane.status;
    const editing = pane instanceof ProfileWorkspaceComponent ? pane.target : undefined;
    // A success keeps the tab's context beside it, such as how many profiles now differ.
    if (transient?.kind === "success")
      return {
        kind: "success",
        text: joinInline([
          transient.text,
          profileDashboardContext(
            this.inspection,
            editing,
            width - visibleWidth(transient.text) - 5,
            true,
          ),
        ]),
      };
    if (transient) return transient;
    return { kind: "plain", text: profileDashboardContext(this.inspection, editing, width) };
  }
  render(width: number): string[] {
    if (!this.current()) return [];
    const { theme } = this.options.workspace;
    const text = profileDashboardTextWidth(width);
    const status = profileDashboardStatusLines(this.status(text), theme, text);
    this.statusRows = status.length;
    const prompt = this.overlay?.prompt(text);
    return renderProfileDashboard(
      { tab: this.tab, status, rows: this.pane().renderWithPrompt(width, prompt) },
      { theme, width, height: this.options.workspace.getHeight() },
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
