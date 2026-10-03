import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type {
  FullScreenKeymapOptions,
  FullScreenSelectionKeybindingId,
} from "../manager/keymap.ts";
import { listDetailMotionFromAction } from "../manager/list-detail.ts";
import { ListDetailShell } from "../manager/list-detail-shell.ts";
import type { ActivityRow } from "./model.ts";
import type { ActivityActionRequest, ActivityDetailRequest } from "./service.ts";
import { needsYou, type ActivityTreeOptions } from "./tree.ts";
import {
  activitySectionId,
  groupedActivityPath,
  groupedActivitySource as source,
  groupedActivityTree,
  type GroupedActivityRow,
} from "./grouped-tree.ts";
import { activityShortcuts, renderGroupedActivity } from "./grouped-render.ts";
import type { ActivitySection } from "./view-protocol.ts";

export interface ActivityPresentation {
  readonly shell: ListDetailShell;
  readonly collapsed: Set<string>;
  readonly expandedHistory: Set<string>;
  focus: string | undefined;
}
export const makeActivityPresentation = (): ActivityPresentation => ({
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
  /** Closes the manager; an action request is invoked after closing (handoff actions). */
  readonly close: (action?: ActivityActionRequest) => void;
  /** Invokes a `handoff: false` action in place; without it, every action closes the manager. */
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
/** Producer UI takes over unless the producer declares the action opens none. */
const handsOff = (action: ActivityAction) => action.handoff !== false;
const sameAction = (left: ActivityAction, right: ActivityAction) =>
  left.id === right.id &&
  left.label === right.label &&
  left.confirmation === right.confirmation &&
  handsOff(left) === handsOff(right);
const ACTION_ALIASES = new Map([
  ["x", ["stop", "skip"]],
  ["i", ["interrupt"]],
  ["u", ["resume"]],
  ["m", ["reply", "message"]],
  ["e", ["rename"]],
  ["c", ["clear", "clear-finished"]],
]);

/** Shared state is presentation only; source actions and fetching stay at the host boundary. */
export class ActivityComponent {
  readonly shell: ListDetailShell;
  readonly presentation: ActivityPresentation;
  private alternateHelp = false;
  private actionPage = 0;
  private detailRequestSequence = 0;
  private cancellationPending = false;
  private closed = false;
  private preserveDetailPosition = false;
  private follow = false;
  private technical = false;
  private initialized = false;
  private selectedIdentity: string | undefined;
  private requested: ActivityDetailRequest | undefined;
  private displayed: { readonly row: ActivityRow; readonly actionPage: number } | undefined;
  private loaded: { readonly request: ActivityDetailRequest; readonly text: string } | undefined;
  private confirmation:
    | { readonly request: ActivityActionRequest; readonly action: ActivityAction }
    | undefined;
  private fullTree: TreeCache | undefined;
  private visibleTree: VisibleCache | undefined;
  private readonly options: ActivityComponentOptions;
  constructor(options: ActivityComponentOptions) {
    this.options = options;
    this.presentation = options.presentation ?? makeActivityPresentation();
    this.shell = this.presentation.shell;
    if (options.initialSection) this.presentation.focus = undefined;
  }
  /** Every row expanded; rebuilt only when the published rows change. */
  private allEntries() {
    const rows = this.options.snapshot();
    if (this.fullTree?.rows === rows) return this.fullTree.entries;
    const entries = groupedActivityTree(rows, {
      retainPhaseHistory: true,
      expandedHistory: new Set(rows.map((row) => row.key)),
    });
    this.fullTree = { rows, entries };
    return entries;
  }
  /** The visible tree; rebuilt when rows or presentation state change. */
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
    const options: ActivityTreeOptions = {
      collapsed: prefs.collapsed,
      expandedHistory: prefs.expandedHistory,
    };
    if (prefs.focus) Object.assign(options, { focus: prefs.focus });
    const entries = groupedActivityTree(rows, { ...options, retainPhaseHistory: true });
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
  private selected() {
    if (!this.initialized) {
      this.initialized = true;
      const all = this.allEntries();
      const section = this.options.initialSection;
      const matching = (entry: GroupedActivityRow) =>
        section === "workflows"
          ? entry.type === "workflow"
          : source(entry)?.kind === (section === "tasks" ? "command" : "agent");
      const initial = section
        ? (all.find((entry) => entry.section === section && matching(entry)) ??
          all.find(matching) ??
          all.find((entry) => entry.id === activitySectionId(section)))
        : !this.shell.state.selectedId
          ? all.find((entry) => entry.type === "workflow" || entry.type === "member")
          : undefined;
      if (initial) this.reveal(initial.id);
    }
    let entries = this.entries();
    const id = this.shell.state.selectedId;
    if (id && !entries.some((entry) => entry.id === id)) {
      // A selected source settling must stay selected when its branch moves into history.
      for (const ancestor of groupedActivityPath(this.allEntries(), id))
        if (ancestor.history) this.presentation.expandedHistory.add(ancestor.id);
      entries = this.entries();
    }
    this.shell.reconcile(entries.map((entry) => entry.id));
    const selected = entries[this.shell.state.selected];
    const row = source(selected);
    const identity = row ? JSON.stringify([row.key, row.generation]) : selected?.id;
    if (identity !== this.selectedIdentity) {
      this.selectedIdentity = identity;
      this.follow = false;
      this.actionPage = 0;
      this.preserveDetailPosition = false;
      this.cancellationPending ||= this.requested !== undefined;
      this.requested = undefined;
      this.detailRequestSequence++;
      this.shell.resetDetailWindow();
    }
    this.shell.ensureSelectionPane(
      !!selected && !(selected.type === "section" && selected.children === 0),
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
  /**
   * Producer UI takes over for handoff actions; others run while the manager stays open. Unrelated
   * source updates must not void a choice, so an action the source still offers unchanged targets
   * its current revision; anything else keeps the displayed revision and fails as stale.
   */
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
      this.loaded = { request, text: text.slice(0, 16384) };
      this.preserveDetailPosition = preservePosition;
      this.options.requestRender();
    });
  }
  /** Host calls this on source publication. Follow is opt-in; rendering never fetches. */
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
      const result = this.shell.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (result?._tag === "Action" && result.action === "confirm") {
        const { request, action } = this.confirmation;
        this.confirmation = undefined;
        this.dispatch(request, action);
      } else if (
        result?._tag === "Action" &&
        (result.action === "cancel" || result.action === "quit")
      )
        this.confirmation = undefined;
      this.options.requestRender();
      return;
    }
    const { entries, selected } = this.selected();
    this.flushCancellation();
    const row = source(selected);
    if (this.shell.state.pane === "list" && selected) {
      const back = matchesKey(data, "h") || matchesKey(data, Key.left);
      const forward = matchesKey(data, "l") || matchesKey(data, Key.right);
      if ((back && selected.expanded) || (forward && selected.children && !selected.expanded)) {
        if (back) {
          this.presentation.collapsed.add(selected.id);
          this.presentation.expandedHistory.delete(selected.id);
        } else {
          this.presentation.collapsed.delete(selected.id);
          this.presentation.expandedHistory.add(selected.id);
        }
        this.shell.resetDetailScroll();
        this.options.requestRender();
        return;
      }
      if (back && selected.parentId && entries.some((entry) => entry.id === selected.parentId)) {
        this.shell.select(
          entries.findIndex((entry) => entry.id === selected.parentId),
          entries.map((entry) => entry.id),
        );
        this.selected();
        this.flushCancellation();
        this.options.requestRender();
        return;
      }
    }
    const result = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: activityShortcuts,
    });
    if (!result) return;
    if (result._tag === "Shortcut") {
      if (result.key === "w") {
        const waiting = needsYou(this.options.snapshot());
        const urgent =
          waiting[(waiting.findIndex((item) => item.key === row?.key) + 1) % waiting.length];
        if (urgent) this.reveal(urgent.key);
      } else if (result.key === "a")
        this.actionPage =
          (this.actionPage + 1) % Math.max(1, Math.ceil((row?.actions?.length ?? 0) / 9));
      else if (result.key === "r" && row) this.loadDetails(row, !this.follow);
      else if (result.key === "t" && row) this.technical = !this.technical;
      else if (result.key === "f" && row && !row.retained) {
        this.follow = !this.follow;
        if (this.follow && this.shell.state.pane === "detail") this.loadDetails(row);
        else if (!this.follow) this.cancelDetails();
      } else if (result.key === "z")
        this.presentation.focus = this.presentation.focus ? undefined : selected?.id;
      else if (row && !row.retained) {
        const shown = this.displayed;
        const action =
          shown?.row.key === row.key && shown.row.generation === row.generation
            ? /^[1-9]$/.test(result.key)
              ? shown.row.actions?.[shown.actionPage * 9 + Number(result.key) - 1]
              : ACTION_ALIASES.get(result.key)?.flatMap(
                  (id) => shown.row.actions?.filter((action) => action.id === id) ?? [],
                )[0]
            : undefined;
        if (action && shown) {
          const request = {
            key: shown.row.key,
            generation: shown.row.generation,
            revision: shown.row.revision,
            actionId: action.id,
          };
          if (handsOff(action) || !this.options.invoke) this.cancelDetails();
          if (action.confirmation !== undefined) this.confirmation = { request, action };
          else this.dispatch(request, action);
        }
      }
    } else if (result.action === "confirm" && selected) {
      this.shell.enterPane();
      if (this.shell.state.pane === "detail" && row) this.loadDetails(row);
    } else {
      if (result.action === "help") this.alternateHelp = !this.alternateHelp;
      const motion = listDetailMotionFromAction(result.action);
      if (motion) {
        const wasDetail = this.shell.state.pane === "detail";
        const changed = this.shell.applyMotion(motion, {
          rowCount: entries.length,
          hasSelection: !!selected,
        });
        if (changed._tag === "Close") this.close();
        else if (changed._tag === "Update") {
          if (changed.movedSelection)
            this.shell.select(
              changed.state.selected,
              entries.map((entry) => entry.id),
            );
          if (changed.scrolledDetail && this.shell.state.detailScroll > 0 && this.follow) {
            this.follow = false;
            this.cancelDetails();
          }
          if (!wasDetail && changed.state.pane === "detail" && row) this.loadDetails(row);
        }
      }
    }
    this.selected();
    this.flushCancellation();
    this.options.requestRender();
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const { entries, selected } = this.selected();
    const row = source(selected);
    this.actionPage = Math.min(
      this.actionPage,
      Math.max(0, Math.ceil((row?.actions?.length ?? 0) / 9) - 1),
    );
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
        confirmation: this.confirmation?.action.confirmation,
        follow: this.follow,
        technical: this.technical,
        preserveDetailPosition: this.preserveDetailPosition,
      },
      width,
    );
    if (this.options.height() > 3) this.preserveDetailPosition = false;
    return lines;
  }
}
