import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { FullScreenResolution } from "../manager/keymap.ts";
import type {
  FullScreenAction,
  FullScreenKeymapOptions,
  FullScreenSelectionKeybindingId,
} from "../manager/keymap.ts";
import { listDetailMotionFromAction, type DetailWindowPosition } from "../manager/list-detail.ts";
import { ListDetailShell } from "../manager/list-detail-shell.ts";
import { isListMotion } from "../manager/list-navigation.ts";
import {
  activityActionForKey,
  activityActionPages,
  activityShortcuts,
  isSectionAction,
} from "./action-keys.ts";
import { activityCanFollow, needsYou } from "./attention.ts";
import { activityFilterMatcher } from "./filter.ts";
import { activityInspectionKey } from "./widget-projection.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityActionRequest, ActivityDetailRequest } from "./service.ts";
import {
  activitySectionId,
  groupedActivityPath,
  groupedActivitySource as source,
  groupedActivityTree,
  type GroupedActivityRow,
} from "./grouped-tree.ts";
import { renderGroupedActivity, type ActivityFilterView } from "./grouped-render.ts";
import type { ActivitySection } from "./view-protocol.ts";
import type { ActivityDetail } from "./protocol.ts";

export interface ActivityPresentation {
  readonly shell: ListDetailShell;
  readonly collapsed: Set<string>;
  readonly expandedHistory: Set<string>;
  /** Failures the user has looked at, by `activityInspectionKey`; the widget retires them. */
  readonly inspected: Set<string>;
  focus: string | undefined;
}
export const freshActivityPresentation = (): ActivityPresentation => ({
  shell: new ListDetailShell(),
  collapsed: new Set(),
  expandedHistory: new Set(),
  inspected: new Set(),
  focus: undefined,
});
export interface ActivityComponentOptions {
  readonly snapshot: () => readonly ActivityRow[];
  readonly initialSection?: ActivitySection;
  readonly starting?: () => number;
  readonly presentation?: ActivityPresentation;
  readonly theme: Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg">>;
  readonly height: () => number;
  readonly now?: () => number;
  readonly close: (action?: ActivityActionRequest) => void;
  readonly invoke?: (action: ActivityActionRequest) => void;
  readonly requestRender: () => void;
  readonly loadDetail?: (
    request: ActivityDetailRequest,
    deliver: (detail: ActivityDetail) => void,
  ) => void;
  readonly cancelDetail?: () => void;
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly keybindingLabel?: (id: FullScreenSelectionKeybindingId, fallback: string) => string;
}
interface TreeCache {
  readonly rows: readonly ActivityRow[];
  readonly entries: readonly GroupedActivityRow[];
}
interface FullTreeCache extends TreeCache {
  readonly members: number;
}
interface VisibleCache extends TreeCache {
  readonly focus: string | undefined;
  readonly collapsed: ReadonlySet<string>;
  readonly expandedHistory: ReadonlySet<string>;
  readonly query: string;
}
interface ActivityMatcher {
  readonly query: string;
  readonly matches: ((row: ActivityRow) => boolean) | undefined;
}
const sameSet = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && Arr.every([...left], (value) => right.has(value));
type ActivityAction = NonNullable<ActivityRow["actions"]>[number];
const handsOff = (action: ActivityAction) => action.handoff !== false;
const sameAction = (left: ActivityAction, right: ActivityAction) =>
  left.id === right.id &&
  left.label === right.label &&
  left.confirmation === right.confirmation &&
  left.scope === right.scope &&
  handsOff(left) === handsOff(right);

interface PendingConfirmation {
  readonly request: ActivityActionRequest;
  readonly action: ActivityAction;
  readonly key: string | undefined;
}

/** An action on screen and the source it runs on; a section heading gathers its members'. */
interface ActionOffer {
  readonly row: ActivityRow;
  readonly action: ActivityAction;
}

/** Running work opens following its newest output; anything else opens at its top. */
const opensFollowed = (row: ActivityRow | undefined): boolean =>
  row?.status === "running" && activityCanFollow(row);

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
  private displayed:
    | {
        readonly identity: string | undefined;
        readonly offers: ReadonlyArray<ActionOffer>;
        readonly actionPage: number;
      }
    | undefined;
  private filterQuery = "";
  private filterTyping = false;
  private readonly filterInput = new Input();
  /** Branches folded while a filter applies; a new query opens every branch to its matches. */
  private readonly filterFolded = new Set<string>();
  /** The selection when filtering began, restored if a query left nothing selected. */
  private filterOrigin: string | undefined;
  private matcherCache: ActivityMatcher = { query: "", matches: undefined };
  private loaded:
    | { readonly request: ActivityDetailRequest; readonly detail: ActivityDetail }
    | undefined;
  private confirmation: PendingConfirmation | undefined;
  private fullTree: FullTreeCache | undefined;
  private visibleTree: VisibleCache | undefined;
  private readonly options: ActivityComponentOptions;
  constructor(options: ActivityComponentOptions) {
    this.options = options;
    this.presentation = options.presentation ?? freshActivityPresentation();
    this.shell = this.presentation.shell;
    if (options.initialSection) this.presentation.focus = undefined;
    // The first selection previews at once; later selections preview as they change.
    this.syncDetails(source(this.selected().selected));
  }
  private allEntries() {
    return this.fullTreeCache().entries;
  }
  private fullTreeCache(): FullTreeCache {
    const rows = this.options.snapshot();
    if (this.fullTree?.rows === rows) return this.fullTree;
    const entries = groupedActivityTree(rows, {
      expandedHistory: new Set(Arr.map(rows, (row) => row.key)),
    });
    this.fullTree = {
      rows,
      entries,
      members: Arr.filter(entries, (entry) => entry.type === "member").length,
    };
    return this.fullTree;
  }
  /** The typed filter's matcher, or `undefined` while no query filters the tree. */
  private matcher(): ((row: ActivityRow) => boolean) | undefined {
    if (this.matcherCache.query !== this.filterQuery)
      this.matcherCache = {
        query: this.filterQuery,
        matches: activityFilterMatcher(this.filterQuery),
      };
    return this.matcherCache.matches;
  }
  private entries() {
    const prefs = this.presentation;
    const rows = this.options.snapshot();
    const all = this.allEntries();
    if (prefs.focus && !Arr.some(all, (entry) => entry.id === prefs.focus)) prefs.focus = undefined;
    const matches = this.matcher();
    const query = matches ? this.filterQuery : "";
    const collapsed = matches ? this.filterFolded : prefs.collapsed;
    const cached = this.visibleTree;
    if (
      cached?.rows === rows &&
      cached.focus === prefs.focus &&
      cached.query === query &&
      sameSet(cached.collapsed, collapsed) &&
      sameSet(cached.expandedHistory, prefs.expandedHistory)
    )
      return cached.entries;
    const entries = groupedActivityTree(rows, {
      collapsed,
      expandedHistory: prefs.expandedHistory,
      ...(prefs.focus && { focus: prefs.focus }),
      ...(matches && { matches }),
    });
    this.visibleTree = {
      rows,
      entries,
      focus: prefs.focus,
      collapsed: new Set(collapsed),
      expandedHistory: new Set(prefs.expandedHistory),
      query,
    };
    return entries;
  }
  private reveal(id: string): void {
    this.presentation.focus = undefined;
    const matches = this.matcher();
    const row = Option.getOrUndefined(
      Arr.findFirst(this.options.snapshot(), (candidate) => candidate.key === id),
    );
    // A filter that hides the item gives way to it.
    if (matches && row && !matches(row)) this.resetFilter();
    const all = this.allEntries();
    for (const entry of groupedActivityPath(all, id)) {
      this.presentation.collapsed.delete(entry.id);
      this.filterFolded.delete(entry.id);
      this.presentation.expandedHistory.add(entry.id);
    }
    this.selectId(this.entries(), id);
  }
  private selectId(entries: readonly GroupedActivityRow[], id: string): void {
    this.shell.select(
      Option.getOrElse(
        Arr.findFirstIndex(entries, (entry) => entry.id === id),
        () => -1,
      ),
      Arr.map(entries, (entry) => entry.id),
    );
  }
  /**
   * Opening selects what needs the user's input first: the first such item in the tree, or, for
   * `/tasks` and `/subagents`, the first in that section. Otherwise `/activity` keeps the last
   * selection and the others select their first matching item.
   */
  private initialEntry(): GroupedActivityRow | undefined {
    const all = this.allEntries();
    const section = this.options.initialSection;
    const waiting = new Set(Arr.map(needsYou(this.options.snapshot()), (row) => row.key));
    const needsInput = (entry: GroupedActivityRow) =>
      entry.type === "member" && waiting.has(entry.id);
    if (!section)
      return (
        Option.getOrUndefined(Arr.findFirst(all, needsInput)) ??
        (this.shell.state.selectedId
          ? undefined
          : Option.getOrUndefined(Arr.findFirst(all, (entry) => entry.type === "member")))
      );
    const matching = (entry: GroupedActivityRow) =>
      source(entry)?.kind === (section === "tasks" ? "command" : "agent");
    return (
      Option.getOrUndefined(
        Arr.findFirst(all, (entry) => entry.section === section && needsInput(entry)),
      ) ??
      Option.getOrUndefined(
        Arr.findFirst(all, (entry) => entry.section === section && matching(entry)),
      ) ??
      Option.getOrUndefined(Arr.findFirst(all, matching)) ??
      Option.getOrUndefined(Arr.findFirst(all, (entry) => entry.id === activitySectionId(section)))
    );
  }
  private selectableEntries(): readonly GroupedActivityRow[] {
    const entries = this.entries();
    const id = this.shell.state.selectedId;
    if (!id || Arr.some(entries, (entry) => entry.id === id)) return entries;
    for (const ancestor of groupedActivityPath(this.allEntries(), id))
      if (ancestor.history) this.presentation.expandedHistory.add(ancestor.id);
    return this.entries();
  }
  private resetSelectionState(identity: string | undefined, row: ActivityRow | undefined): void {
    this.selectedIdentity = identity;
    this.follow = opensFollowed(row);
    this.actionPage = 0;
    this.preserveDetailPosition = false;
    this.openAtTop = !this.follow;
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
    this.shell.reconcile(Arr.map(entries, (entry) => entry.id));
    const selected = entries[this.shell.state.selected];
    const row = source(selected);
    const identity = row ? JSON.stringify([row.key, row.generation]) : selected?.id;
    if (identity !== this.selectedIdentity) this.resetSelectionState(identity, row);
    // A section heading folds in place; only a source's detail can be entered.
    this.shell.ensureSelectionPane(selected?.type === "member");
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
    const row = Option.getOrUndefined(
      Arr.findFirst(this.options.snapshot(), (candidate) => candidate.key === displayed.key),
    );
    const request =
      row &&
      !row.retained &&
      row.generation === displayed.generation &&
      row.actions !== undefined &&
      Arr.some(row.actions, (offered) => sameAction(offered, action))
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
    this.options.loadDetail?.(request, (detail) => {
      const current = source(
        Option.getOrUndefined(
          Arr.findFirst(this.allEntries(), (entry) => entry.id === this.shell.state.selectedId),
        ),
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
      this.loaded = { request, detail };
      this.preserveDetailPosition = preservePosition;
      if (preservePosition) this.openAtTop = false;
      this.options.requestRender();
    });
  }
  /**
   * Keeps the shown detail current: a newly selected source loads at once, and a loaded one
   * reloads on change while it is only previewed or explicitly followed. Inspected details
   * otherwise stay put so they can be read; `r` refreshes them. Work that reaches a final state
   * won't change again, so an inspection the reader hasn't scrolled picks up its final result.
   */
  private syncDetails(row: ActivityRow | undefined): void {
    if (this.closed || this.confirmation || !row || row.retained) return;
    const current = this.requested ?? this.loaded?.request;
    const sameItem = current?.key === row.key && current.generation === row.generation;
    if (!sameItem) return this.loadDetails(row);
    if (current.revision === row.revision) return;
    if (this.follow || this.shell.state.pane === "list") this.loadDetails(row);
    else if (isFinished(row) && this.shell.detailAtTop) this.loadDetails(row, true);
  }
  private settleInput(): void {
    const { selected } = this.selected();
    this.flushCancellation();
    this.syncDetails(source(selected));
    this.options.requestRender();
  }
  update(): void {
    if (this.closed) return;
    const { selected } = this.selected();
    this.flushCancellation();
    this.syncDetails(source(selected));
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (this.confirmation) {
      this.handleConfirmationInput(data, this.confirmation);
      return;
    }
    const { entries, selected } = this.selected();
    this.flushCancellation();
    if (this.filterTyping) {
      this.handleFilterInput(data, entries, selected);
      return this.settleInput();
    }
    const row = source(selected);
    if (
      this.shell.state.pane === "list" &&
      selected &&
      this.handleTreeInput(data, entries, selected)
    )
      return this.settleInput();
    const result = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: activityShortcuts,
    });
    if (!result) return;
    FullScreenResolution.$match(result, {
      Shortcut: ({ key }) => this.handleShortcut(key, selected, row),
      Action: ({ action }) => this.handleAction(action, entries, selected),
    });
    if (!this.closed) this.settleInput();
  }
  private handleAction(
    action: FullScreenAction,
    entries: readonly GroupedActivityRow[],
    selected: GroupedActivityRow | undefined,
  ): void {
    const inList = this.shell.state.pane === "list";
    if (action === "confirm" && selected?.type === "section") {
      if (selected.children) this.setExpanded(selected.id, !selected.expanded);
    } else if (action === "confirm" && selected) this.enterSelection();
    // There is nothing to filter until something appears.
    else if (action === "search" && inList && this.fullTreeCache().members > 0) this.startFilter();
    // An applied filter is cleared before the next Esc closes.
    else if (action === "cancel" && inList && this.matcher()) this.resetFilter();
    else this.handleNavigation(action, entries, selected);
  }
  /** While the filter takes the keys, letters type and only list motions, Enter, and Esc act. */
  private handleFilterInput(
    data: string,
    entries: readonly GroupedActivityRow[],
    selected: GroupedActivityRow | undefined,
  ): void {
    const result = this.shell.keymap.resolve(data, {
      mode: "search",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (Predicate.isTagged(result, "Action")) {
      if (result.action === "cancel") this.resetFilter();
      else if (result.action === "confirm") {
        this.filterTyping = false;
        if (!this.matcher()) this.resetFilter();
      } else if (isListMotion(result.action))
        this.handleNavigation(result.action, entries, selected);
      return;
    }
    this.filterInput.handleInput(data);
    const query = this.filterInput.getValue();
    if (query !== this.filterQuery) this.applyFilter(query);
  }
  private startFilter(): void {
    if (!this.matcher()) this.filterOrigin = this.shell.state.selectedId;
    this.filterTyping = true;
    this.filterInput.setValue(this.filterQuery);
    this.shell.keymap.resetChord();
  }
  /** A new query opens every branch to its matches and keeps the selection when it still shows. */
  private applyFilter(query: string): void {
    this.filterQuery = query;
    this.filterFolded.clear();
    const entries = this.entries();
    if (Arr.some(entries, (entry) => entry.id === this.shell.state.selectedId)) return;
    const matches = this.matcher();
    const first =
      Option.getOrUndefined(
        Arr.findFirst(
          entries,
          (entry) => entry.type === "member" && (matches === undefined || matches(entry.row)),
        ),
      ) ?? entries[0];
    if (first) this.selectId(entries, first.id);
  }
  /** Clears the filter, keeping the selected item in view. */
  private resetFilter(): void {
    const filtered = this.matcher() !== undefined;
    this.filterTyping = false;
    this.filterQuery = "";
    this.filterInput.setValue("");
    this.filterFolded.clear();
    const id = this.shell.state.selectedId ?? this.filterOrigin;
    this.filterOrigin = undefined;
    if (
      filtered &&
      id &&
      !Arr.some(this.entries(), (entry) => entry.id === this.shell.state.selectedId) &&
      Arr.some(this.allEntries(), (entry) => entry.id === id)
    )
      this.reveal(id);
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
    // A section heading unfolds, but has no detail to enter.
    if (forward && selected.type === "section" && (selected.expanded || !selected.children))
      return true;
    if ((back && selected.expanded) || (forward && selected.children && !selected.expanded)) {
      // Folding changes the tree, not the selection, so the preview keeps its place.
      this.setExpanded(selected.id, !back);
      return true;
    }
    if (
      !back ||
      !selected.parentId ||
      !Arr.some(entries, (entry) => entry.id === selected.parentId)
    )
      return false;
    this.selectId(entries, selected.parentId);
    return true;
  }
  private setExpanded(id: string, expanded: boolean): void {
    // Folding under a filter lasts only as long as its query.
    if (this.matcher()) {
      if (expanded) this.filterFolded.delete(id);
      else this.filterFolded.add(id);
      return;
    }
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
      this.actionPage =
        (this.actionPage + 1) %
        activityActionPages(Arr.map(this.offers(selected), (offer) => offer.action));
    else if (key === "z")
      this.presentation.focus = this.presentation.focus ? undefined : selected?.id;
    else if (row) this.handleRowShortcut(key, row);
    else if (selected) this.invokeShortcutAction(key);
  }
  private handleRowShortcut(key: string, row: ActivityRow): void {
    if (key === "r") this.loadDetails(row, !this.follow);
    else if (key === "t") this.technical = !this.technical;
    else if (!row.retained) {
      if (key === "f") this.toggleFollow(row);
      else this.invokeShortcutAction(key);
    }
  }
  private revealNextWaiting(row: ActivityRow | undefined): void {
    const waiting = needsYou(this.options.snapshot());
    const urgent =
      waiting[
        (Option.getOrElse(
          Arr.findFirstIndex(waiting, (item) => item.key === row?.key),
          () => -1,
        ) +
          1) %
          waiting.length
      ];
    if (urgent) this.reveal(urgent.key);
  }
  /** Only work that can still produce output is followed; following stops from any row. */
  private toggleFollow(row: ActivityRow): void {
    if (!this.follow && !activityCanFollow(row)) return;
    this.follow = !this.follow;
    if (this.follow) this.loadDetails(row);
    else {
      this.cancelDetails();
      this.keepDetailPlace();
    }
  }
  /**
   * The actions on screen: a row's own, or, on a section heading, the section actions its
   * members offer, once per provider and action.
   */
  private offers(selected: GroupedActivityRow | undefined): ReadonlyArray<ActionOffer> {
    if (!selected) return [];
    if (selected.type === "member") {
      const row = selected.row;
      return row.retained ? [] : Arr.map(row.actions ?? [], (action) => ({ row, action }));
    }
    const seen = new Set<string>();
    const offers: ActionOffer[] = [];
    for (const entry of this.allEntries()) {
      if (entry.type !== "member" || entry.section !== selected.section || entry.row.retained)
        continue;
      for (const action of entry.row.actions ?? []) {
        const id = JSON.stringify([entry.row.providerId, action.id]);
        if (!isSectionAction(action) || seen.has(id)) continue;
        seen.add(id);
        offers.push({ row: entry.row, action });
      }
    }
    return offers;
  }
  /** The selected member's direct children, in tree order. */
  private childrenOf(selected: GroupedActivityRow | undefined): readonly ActivityRow[] {
    if (selected?.type !== "member") return [];
    return Arr.flatMap(this.allEntries(), (entry) =>
      entry.type === "member" && entry.parentId === selected.id ? [entry.row] : [],
    );
  }
  private filterView(): ActivityFilterView | undefined {
    const matches = this.matcher();
    if (!this.filterTyping && !matches) return undefined;
    const theme = this.options.theme;
    return {
      query: matches ? Str.trim(this.filterQuery) : "",
      typing: this.filterTyping,
      matches: matches
        ? Arr.filter(this.allEntries(), (entry) => entry.type === "member" && matches(entry.row))
            .length
        : this.fullTreeCache().members,
      input: (width) => theme.fg("accent", this.filterInput.render(Math.max(1, width))[0] ?? ""),
    };
  }
  private invokeShortcutAction(key: string): void {
    const shown = this.displayed;
    if (!shown || shown.identity !== this.selectedIdentity) return;
    const action = activityActionForKey(
      Arr.map(shown.offers, (offer) => offer.action),
      key,
      shown.actionPage,
    );
    const offer = Option.getOrUndefined(
      Arr.findFirst(shown.offers, (candidate) => candidate.action === action),
    );
    if (!action || !offer) return;
    const request = {
      key: offer.row.key,
      generation: offer.row.generation,
      revision: offer.row.revision,
      actionId: action.id,
    };
    if (handsOff(action) || !this.options.invoke) this.cancelDetails();
    if (action.confirmation !== undefined) this.confirmation = { request, action, key };
    else this.dispatch(request, action);
  }
  private enterSelection(): void {
    this.shell.enterPane();
  }
  private handleNavigation(
    action: FullScreenAction,
    entries: readonly GroupedActivityRow[],
    selected: GroupedActivityRow | undefined,
  ): void {
    if (action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(action);
    if (!motion) return;
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
        Arr.map(entries, (entry) => entry.id),
      );
    if (changed.scrolledDetail) this.keepDetailPlace();
    if (changed.scrolledDetail && this.shell.state.detailScroll > 0 && this.follow) {
      this.follow = false;
      this.cancelDetails();
    }
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
  /** A failure shown in the preview or details has been seen, so the widget can let it go. */
  private markInspected(row: ActivityRow): void {
    if (row.status !== "failed") return;
    const inspected = this.presentation.inspected;
    const key = activityInspectionKey(row);
    if (inspected.has(key)) return;
    // Keep only failures that are still published, so the set stays bounded.
    const live = new Set(Arr.map(this.options.snapshot(), activityInspectionKey));
    for (const seen of inspected) if (!live.has(seen)) inspected.delete(seen);
    inspected.add(key);
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const { entries, selected } = this.selected();
    const row = source(selected);
    const detailPosition = this.detailPosition();
    const offers = this.offers(selected);
    const actions = Arr.map(offers, (offer) => offer.action);
    this.actionPage = Math.min(this.actionPage, activityActionPages(actions) - 1);
    this.displayed = offers.length
      ? { identity: this.selectedIdentity, offers, actionPage: this.actionPage }
      : undefined;
    const lines = renderGroupedActivity(
      this.options,
      {
        shell: this.shell,
        entries,
        itemCount: this.fullTreeCache().members,
        selected,
        alternateHelp: this.alternateHelp,
        actionPage: this.actionPage,
        loaded: this.loaded,
        loading:
          this.options.loadDetail !== undefined &&
          row !== undefined &&
          this.requested?.key === row.key,
        confirmation: this.confirmation && {
          text: this.confirmation.action.confirmation ?? "",
          label: this.confirmation.action.label,
          key: this.confirmation.key,
        },
        follow: this.follow,
        technical: this.technical,
        detailPosition,
        actions,
        children: this.childrenOf(selected),
        filter: this.filterView(),
      },
      width,
    );
    // A single pane showing the list hides the preview; otherwise the selected item's detail is
    // on screen.
    if (row && (this.shell.state.arrangement !== "single" || this.shell.state.details))
      this.markInspected(row);
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
