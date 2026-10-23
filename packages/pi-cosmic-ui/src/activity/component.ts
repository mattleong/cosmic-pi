import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { FullScreenResolution } from "../manager/keymap.ts";
import type {
  FullScreenAction,
  FullScreenKeymapOptions,
  FullScreenSelectionKeybindingId,
} from "../manager/keymap.ts";
import { listDetailMotionFromAction, type DetailWindowPosition } from "../manager/list-detail.ts";
import { ListDetailShell } from "../manager/list-detail-shell.ts";
import { ACTIVITY_LIMITS } from "./limits.ts";
import {
  ACTIVITY_ACTION_PAGE_SIZE,
  activityActionForKey,
  activityActionPages,
  activityShortcuts,
} from "./action-keys.ts";
import { needsYou } from "./attention.ts";
import type { ActivityRow } from "./model.ts";
import type { ActivityActionRequest, ActivityDetailRequest } from "./service.ts";
import {
  activitySectionId,
  groupedActivityPath,
  groupedActivitySource as source,
  groupedActivityTree,
  type GroupedActivityRow,
} from "./grouped-tree.ts";
import { renderGroupedActivity } from "./grouped-render.ts";
import type { ActivitySection } from "./view-protocol.ts";

export interface ActivityPresentation {
  readonly shell: ListDetailShell;
  readonly collapsed: Set<string>;
  readonly expandedHistory: Set<string>;
  focus: string | undefined;
}
export const freshActivityPresentation = (): ActivityPresentation => ({
  shell: new ListDetailShell(),
  collapsed: new Set(),
  expandedHistory: new Set(),
  focus: undefined,
});
export interface ActivityComponentOptions {
  readonly snapshot: () => readonly ActivityRow[];
  readonly initialSection?: ActivitySection;
  readonly title?: string;
  readonly starting?: () => number;
  readonly presentation?: ActivityPresentation;
  readonly theme: Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg">>;
  readonly height: () => number;
  readonly now?: () => number;
  readonly close: (action?: ActivityActionRequest) => void;
  readonly invoke?: (action: ActivityActionRequest) => void;
  readonly requestRender: () => void;
  readonly loadDetail?: (request: ActivityDetailRequest, deliver: (text: string) => void) => void;
  readonly cancelDetail?: () => void;
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly keybindingLabel?: (id: FullScreenSelectionKeybindingId, fallback: string) => string;
}
interface TreeCache {
  readonly rows: readonly ActivityRow[];
  readonly entries: readonly GroupedActivityRow[];
}
interface VisibleCache extends TreeCache {
  readonly focus: string | undefined;
  readonly collapsed: ReadonlySet<string>;
  readonly expandedHistory: ReadonlySet<string>;
}
const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every((value) => right.has(value));
type ActivityAction = NonNullable<ActivityRow["actions"]>[number];
const handsOff = (action: ActivityAction) => action.handoff !== false;
const sameAction = (left: ActivityAction, right: ActivityAction) =>
  left.id === right.id &&
  left.label === right.label &&
  left.confirmation === right.confirmation &&
  handsOff(left) === handsOff(right);

interface PendingConfirmation {
  readonly request: ActivityActionRequest;
  readonly action: ActivityAction;
  readonly key: string | undefined;
}
const NUMBERED_ACTION = /^[1-9]$/;

export class ActivityComponent {
  readonly shell: ListDetailShell;
  readonly presentation: ActivityPresentation;
  private alternateHelp = false;
  private actionPage = 0;
  private detailRequestSequence = 0;
  private cancellationPending = false;
  private closed = false;
  private preserveDetailPosition = false;
  private openAtTop = false;
  private anchored = false;
  private follow = false;
  private technical = false;
  private initialized = false;
  private selectedIdentity: string | undefined;
  private requested: ActivityDetailRequest | undefined;
  private displayed: { readonly row: ActivityRow; readonly actionPage: number } | undefined;
  private loaded: { readonly request: ActivityDetailRequest; readonly text: string } | undefined;
  private confirmation: PendingConfirmation | undefined;
  private fullTree: TreeCache | undefined;
  private visibleTree: VisibleCache | undefined;
  private readonly options: ActivityComponentOptions;
  constructor(options: ActivityComponentOptions) {
    this.options = options;
    this.presentation = options.presentation ?? freshActivityPresentation();
    this.shell = this.presentation.shell;
    if (options.initialSection) this.presentation.focus = undefined;
  }
  private allEntries() {
    const rows = this.options.snapshot();
    if (this.fullTree?.rows === rows) return this.fullTree.entries;
    const entries = groupedActivityTree(rows, {
      expandedHistory: new Set(rows.map((row) => row.key)),
    });
    this.fullTree = { rows, entries };
    return entries;
  }
  private entries() {
    const prefs = this.presentation;
    const rows = this.options.snapshot();
    const all = this.allEntries();
    if (prefs.focus && !all.some((entry) => entry.id === prefs.focus)) prefs.focus = undefined;
    const cached = this.visibleTree;
    if (
      cached?.rows === rows &&
      cached.focus === prefs.focus &&
      sameSet(cached.collapsed, prefs.collapsed) &&
      sameSet(cached.expandedHistory, prefs.expandedHistory)
    )
      return cached.entries;
    const entries = groupedActivityTree(rows, {
      collapsed: prefs.collapsed,
      expandedHistory: prefs.expandedHistory,
      ...(prefs.focus && { focus: prefs.focus }),
    });
    this.visibleTree = {
      rows,
      entries,
      focus: prefs.focus,
      collapsed: new Set(prefs.collapsed),
      expandedHistory: new Set(prefs.expandedHistory),
    };
    return entries;
  }
  private reveal(id: string): void {
    this.presentation.focus = undefined;
    const all = this.allEntries();
    for (const entry of groupedActivityPath(all, id)) {
      this.presentation.collapsed.delete(entry.id);
      this.presentation.expandedHistory.add(entry.id);
    }
    const entries = this.entries();
    this.shell.select(
      entries.findIndex((entry) => entry.id === id),
      entries.map((entry) => entry.id),
    );
  }
  private initialEntry(): GroupedActivityRow | undefined {
    const all = this.allEntries();
    const section = this.options.initialSection;
    if (!section)
      return this.shell.state.selectedId ? undefined : all.find((entry) => entry.type === "member");
    const matching = (entry: GroupedActivityRow) =>
      source(entry)?.kind === (section === "tasks" ? "command" : "agent");
    return (
      all.find((entry) => entry.section === section && matching(entry)) ??
      all.find(matching) ??
      all.find((entry) => entry.id === activitySectionId(section))
    );
  }
  private selectableEntries(): readonly GroupedActivityRow[] {
    const entries = this.entries();
    const id = this.shell.state.selectedId;
    if (!id || entries.some((entry) => entry.id === id)) return entries;
    for (const ancestor of groupedActivityPath(this.allEntries(), id))
      if (ancestor.history) this.presentation.expandedHistory.add(ancestor.id);
    return this.entries();
  }
  private resetSelectionState(identity: string | undefined): void {
    this.selectedIdentity = identity;
    this.follow = false;
    this.actionPage = 0;
    this.preserveDetailPosition = false;
    this.openAtTop = true;
    this.anchored = false;
    this.cancellationPending ||= this.requested !== undefined;
    this.requested = undefined;
    this.detailRequestSequence++;
    this.shell.resetDetailWindow();
  }
  private selected() {
    if (!this.initialized) {
      this.initialized = true;
      const initial = this.initialEntry();
      if (initial) this.reveal(initial.id);
    }
    const entries = this.selectableEntries();
    this.shell.reconcile(entries.map((entry) => entry.id));
    const selected = entries[this.shell.state.selected];
    const row = source(selected);
    const identity = row ? JSON.stringify([row.key, row.generation]) : selected?.id;
    if (identity !== this.selectedIdentity) this.resetSelectionState(identity);
    this.shell.ensureSelectionPane(
      selected !== undefined && !(selected.type === "section" && selected.children === 0),
    );
    return { entries, selected };
  }
  private cancelDetails(): void {
    this.detailRequestSequence++;
    this.requested = undefined;
    this.cancellationPending = false;
    this.options.cancelDetail?.();
  }
  private flushCancellation(): void {
    if (this.cancellationPending) this.cancelDetails();
  }
  private close(request?: ActivityActionRequest): void {
    this.closed = true;
    this.follow = false;
    this.cancelDetails();
    this.options.close(request);
  }
  private dispatch(displayed: ActivityActionRequest, action: ActivityAction): void {
    const row = this.options.snapshot().find((candidate) => candidate.key === displayed.key);
    const request =
      row &&
      !row.retained &&
      row.generation === displayed.generation &&
      row.actions?.some((offered) => sameAction(offered, action))
        ? { ...displayed, revision: row.revision }
        : displayed;
    const invoke = this.options.invoke;
    if (handsOff(action) || !invoke) this.close(request);
    else invoke(request);
  }
  private loadDetails(row: ActivityRow, preservePosition = false): void {
    if (this.closed || row.retained) return;
    const sequence = ++this.detailRequestSequence;
    const request: ActivityDetailRequest = {
      key: row.key,
      revision: row.revision,
      generation: row.generation,
    };
    this.requested = request;
    this.options.loadDetail?.(request, (text) => {
      const current = source(
        this.allEntries().find((entry) => entry.id === this.shell.state.selectedId),
      );
      if (
        this.closed ||
        sequence !== this.detailRequestSequence ||
        current?.retained ||
        current?.key !== request.key ||
        current.revision !== request.revision ||
        current.generation !== request.generation
      )
        return;
      this.loaded = { request, text: text.slice(0, ACTIVITY_LIMITS.detail) };
      this.preserveDetailPosition = preservePosition;
      if (preservePosition) this.openAtTop = false;
      this.options.requestRender();
    });
  }
  update(): void {
    if (this.closed) return;
    const { selected } = this.selected();
    this.flushCancellation();
    const row = source(selected);
    if (
      !this.confirmation &&
      this.follow &&
      this.shell.state.pane === "detail" &&
      row &&
      (this.requested?.key !== row.key ||
        this.requested.generation !== row.generation ||
        this.requested.revision !== row.revision)
    )
      this.loadDetails(row);
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (this.confirmation) {
      this.handleConfirmationInput(data, this.confirmation);
      return;
    }
    const { entries, selected } = this.selected();
    this.flushCancellation();
    const row = source(selected);
    if (
      this.shell.state.pane === "list" &&
      selected &&
      this.handleTreeInput(data, entries, selected)
    )
      return;
    const result = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: activityShortcuts,
    });
    if (!result) return;
    FullScreenResolution.$match(result, {
      Shortcut: ({ key }) => this.handleShortcut(key, selected, row),
      Action: ({ action }) => {
        if (action === "confirm" && selected) this.enterSelection(row);
        else this.handleNavigation(action, entries, selected, row);
      },
    });
    this.selected();
    this.flushCancellation();
    this.options.requestRender();
  }
  private handleConfirmationInput(data: string, confirmation: PendingConfirmation): void {
    const result = this.shell.keymap.resolve(data, {
      mode: "confirmation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: activityShortcuts,
    });
    if (
      (Predicate.isTagged(result, "Action") && result.action === "confirm") ||
      (Predicate.isTagged(result, "Shortcut") &&
        confirmation.key !== undefined &&
        result.key === confirmation.key)
    ) {
      this.confirmation = undefined;
      this.dispatch(confirmation.request, confirmation.action);
    } else if (
      Predicate.isTagged(result, "Action") &&
      (result.action === "cancel" || result.action === "quit")
    )
      this.confirmation = undefined;
    this.options.requestRender();
  }
  private handleTreeInput(
    data: string,
    entries: readonly GroupedActivityRow[],
    selected: GroupedActivityRow,
  ): boolean {
    const back = matchesKey(data, "h") || matchesKey(data, Key.left);
    const forward = matchesKey(data, "l") || matchesKey(data, Key.right);
    if ((back && selected.expanded) || (forward && selected.children && !selected.expanded)) {
      this.setExpanded(selected.id, !back);
      this.shell.resetDetailScroll();
      this.options.requestRender();
      return true;
    }
    if (!back || !selected.parentId || !entries.some((entry) => entry.id === selected.parentId))
      return false;
    this.shell.select(
      entries.findIndex((entry) => entry.id === selected.parentId),
      entries.map((entry) => entry.id),
    );
    this.selected();
    this.flushCancellation();
    this.options.requestRender();
    return true;
  }
  private setExpanded(id: string, expanded: boolean): void {
    if (expanded) {
      this.presentation.collapsed.delete(id);
      this.presentation.expandedHistory.add(id);
    } else {
      this.presentation.collapsed.add(id);
      this.presentation.expandedHistory.delete(id);
    }
  }
  private handleShortcut(
    key: string,
    selected: GroupedActivityRow | undefined,
    row: ActivityRow | undefined,
  ): void {
    if (key === "w") this.revealNextWaiting(row);
    else if (key === "a")
      this.actionPage = (this.actionPage + 1) % activityActionPages(row?.actions);
    else if (key === "z")
      this.presentation.focus = this.presentation.focus ? undefined : selected?.id;
    else if (row) this.handleRowShortcut(key, row);
  }
  private handleRowShortcut(key: string, row: ActivityRow): void {
    if (key === "r") this.loadDetails(row, !this.follow);
    else if (key === "t") this.technical = !this.technical;
    else if (!row.retained) {
      if (key === "f") this.toggleFollow(row);
      else this.invokeShortcutAction(key, row);
    }
  }
  private revealNextWaiting(row: ActivityRow | undefined): void {
    const waiting = needsYou(this.options.snapshot());
    const urgent =
      waiting[(waiting.findIndex((item) => item.key === row?.key) + 1) % waiting.length];
    if (urgent) this.reveal(urgent.key);
  }
  private toggleFollow(row: ActivityRow): void {
    this.follow = !this.follow;
    if (this.follow && this.shell.state.pane === "detail") this.loadDetails(row);
    else if (!this.follow) this.cancelDetails();
  }
  private invokeShortcutAction(key: string, row: ActivityRow): void {
    const shown = this.displayed;
    if (!shown || shown.row.key !== row.key || shown.row.generation !== row.generation) return;
    const numbered = NUMBERED_ACTION.test(key);
    const action = numbered
      ? shown.row.actions?.[shown.actionPage * ACTIVITY_ACTION_PAGE_SIZE + Number(key) - 1]
      : activityActionForKey(shown.row.actions ?? [], key);
    if (!action) return;
    const request = {
      key: shown.row.key,
      generation: shown.row.generation,
      revision: shown.row.revision,
      actionId: action.id,
    };
    if (handsOff(action) || !this.options.invoke) this.cancelDetails();
    if (action.confirmation !== undefined)
      this.confirmation = { request, action, key: numbered ? undefined : key };
    else this.dispatch(request, action);
  }
  private enterSelection(row: ActivityRow | undefined): void {
    this.shell.enterPane();
    if (this.shell.state.pane === "detail" && row) this.loadDetails(row);
  }
  private handleNavigation(
    action: FullScreenAction,
    entries: readonly GroupedActivityRow[],
    selected: GroupedActivityRow | undefined,
    row: ActivityRow | undefined,
  ): void {
    if (action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(action);
    if (!motion) return;
    const wasDetail = this.shell.state.pane === "detail";
    const changed = this.shell.applyMotion(motion, {
      rowCount: entries.length,
      hasSelection: selected !== undefined,
    });
    if (Predicate.isTagged(changed, "Close")) {
      this.close();
      return;
    }
    if (!Predicate.isTagged(changed, "Update")) return;
    if (changed.movedSelection)
      this.shell.select(
        changed.state.selected,
        entries.map((entry) => entry.id),
      );
    if (changed.scrolledDetail) this.keepDetailPlace();
    if (changed.scrolledDetail && this.shell.state.detailScroll > 0 && this.follow) {
      this.follow = false;
      this.cancelDetails();
    }
    if (!wasDetail && changed.state.pane === "detail" && row) this.loadDetails(row);
  }
  private keepDetailPlace(): void {
    this.openAtTop = false;
    this.anchored = true;
  }
  private detailPosition(): DetailWindowPosition {
    if (this.follow) return true;
    if (this.openAtTop) return "top";
    return this.preserveDetailPosition || this.anchored ? false : undefined;
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const { entries, selected } = this.selected();
    const row = source(selected);
    const detailPosition = this.detailPosition();
    this.actionPage = Math.min(this.actionPage, activityActionPages(row?.actions) - 1);
    this.displayed = row && !row.retained ? { row, actionPage: this.actionPage } : undefined;
    const lines = renderGroupedActivity(
      this.options,
      {
        shell: this.shell,
        entries,
        selected,
        alternateHelp: this.alternateHelp,
        actionPage: this.actionPage,
        loaded: this.loaded,
        confirmation: this.confirmation && {
          text: this.confirmation.action.confirmation ?? "",
          label: this.confirmation.action.label,
          key: this.confirmation.key,
        },
        follow: this.follow,
        technical: this.technical,
        detailPosition,
      },
      width,
    );
    if (this.options.height() > 3) this.preserveDetailPosition = false;
    if (
      detailPosition === "top" &&
      row &&
      this.loaded?.request.key === row.key &&
      this.loaded.request.generation === row.generation
    )
      this.keepDetailPlace();
    return lines;
  }
}
