import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "../manager/chrome.ts";
import { filterReservedKeyLabel } from "../manager/key-labels.ts";
import type {
  FullScreenKeymapOptions,
  FullScreenSelectionKeybindingId,
} from "../manager/keymap.ts";
import { listDetailMotionFromAction } from "../manager/list-detail.ts";
import {
  ListDetailShell,
  framedFill,
  framedScreen,
  framedWideRows,
  framedStackedRows,
  listDetailFrame,
} from "../manager/list-detail-shell.ts";
import type { ActivityRow } from "./model.ts";
import type { ActivityActionRequest, ActivityDetailRequest } from "./service.ts";
import { activityPath, activityTree, needsYou } from "./tree.ts";
import {
  activityStartupGlyph,
  activityElapsed,
  activityOwnerLabel,
  activityRowLine,
  activityStatus,
  activityType,
} from "./widget.ts";

const shortcuts = new Set(["a", "c", "f", "n", "r", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
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
  readonly starting?: () => number;
  readonly presentation?: ActivityPresentation;
  readonly theme: Pick<Theme, "fg"> & Partial<Pick<Theme, "bg">>;
  readonly height: () => number;
  readonly now?: () => number;
  readonly close: (action?: ActivityActionRequest) => void;
  readonly requestRender: () => void;
  readonly loadDetail?: (request: ActivityDetailRequest, deliver: (text: string) => void) => void;
  readonly matchesKeybinding?: FullScreenKeymapOptions["matchesKeybinding"];
  readonly keybindingLabel?: (id: FullScreenSelectionKeybindingId, fallback: string) => string;
}
/** Only presentation state is shared across openings; domain state stays in ActivityService. */
export class ActivityComponent {
  readonly shell: ListDetailShell;
  readonly presentation: ActivityPresentation;
  private actionPage = 0;
  private detailRequestSequence = 0;
  private preserveDetailPosition = false;
  private displayed: { readonly row: ActivityRow; readonly actionPage: number } | undefined;
  private loaded: { readonly request: ActivityDetailRequest; readonly text: string } | undefined;
  private confirmation:
    | { readonly request: ActivityActionRequest; readonly text: string }
    | undefined;
  private readonly options: ActivityComponentOptions;
  constructor(options: ActivityComponentOptions) {
    this.options = options;
    this.presentation = options.presentation ?? makeActivityPresentation();
    this.shell = this.presentation.shell;
  }
  private entries() {
    const rows = this.options.snapshot();
    const prefs = this.presentation;
    if (prefs.focus && !rows.some((row) => row.key === prefs.focus)) prefs.focus = undefined;
    const options = { collapsed: prefs.collapsed, expandedHistory: prefs.expandedHistory };
    if (prefs.focus) Object.assign(options, { focus: prefs.focus });
    return activityTree(rows, options);
  }
  private selected() {
    let entries = this.entries();
    const selectedId = this.shell.state.selectedId;
    if (
      !this.presentation.focus &&
      selectedId &&
      !entries.some((entry) => entry.row.key === selectedId)
    ) {
      const rows = this.options.snapshot();
      const expanded = activityTree(rows, {
        collapsed: this.presentation.collapsed,
        expandedHistory: new Set(rows.map((row) => row.key)),
      });
      let index = expanded.findIndex((entry) => entry.row.key === selectedId);
      while (index > 0 && expanded[index]?.depth !== 0) index--;
      const root = expanded[index];
      if (root?.history) {
        this.presentation.expandedHistory.add(root.row.key);
        entries = this.entries();
      }
    }
    this.shell.reconcile(entries.map((entry) => entry.row.key));
    return { entries, selected: entries[this.shell.state.selected] };
  }
  private ancestorPath(row: ActivityRow): readonly ActivityRow[] {
    return activityPath(this.options.snapshot(), row.key);
  }
  private loadDetails(row: ActivityRow, preservePosition = false): void {
    const sequence = ++this.detailRequestSequence;
    const request: ActivityDetailRequest = {
      key: row.key,
      revision: row.revision,
      generation: row.generation,
    };
    this.options.loadDetail?.(request, (text) => {
      const current = this.options.snapshot().find((item) => item.key === request.key);
      if (
        sequence !== this.detailRequestSequence ||
        current?.revision !== request.revision ||
        current.generation !== request.generation ||
        this.shell.state.selectedId !== request.key
      )
        return;
      this.loaded = { request, text: text.slice(0, 16384) };
      this.preserveDetailPosition = preservePosition;
      this.options.requestRender();
    });
  }
  handleInput(data: string): void {
    if (this.confirmation) {
      const result = this.shell.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (result?._tag === "Action" && result.action === "confirm")
        this.options.close(this.confirmation.request);
      else if (
        result?._tag === "Action" &&
        (result.action === "cancel" || result.action === "quit")
      )
        this.confirmation = undefined;
      this.options.requestRender();
      return;
    }
    const { entries, selected } = this.selected();
    const result = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: shortcuts,
    });
    if (!result) return;
    if (result._tag === "Shortcut") {
      if (result.key === "n") {
        const waiting = needsYou(this.options.snapshot());
        const index = waiting.findIndex((row) => row.key === selected?.row.key);
        const urgent = waiting[(index + 1) % waiting.length];
        if (urgent) {
          this.presentation.focus = undefined;
          for (const ancestor of this.ancestorPath(urgent)) {
            this.presentation.collapsed.delete(ancestor.key);
            this.presentation.expandedHistory.add(ancestor.key);
          }
          const all = this.entries();
          this.shell.select(
            all.findIndex((entry) => entry.row.key === urgent.key),
            all.map((entry) => entry.row.key),
          );
        }
      } else if (result.key === "a")
        this.actionPage =
          (this.actionPage + 1) % Math.max(1, Math.ceil((selected?.row.actions?.length ?? 0) / 9));
      else if (result.key === "r" && selected) this.loadDetails(selected.row, true);
      else if (result.key === "f")
        this.presentation.focus = this.presentation.focus ? undefined : selected?.row.key;
      else if (result.key === "c" && selected?.children) {
        const key = selected.row.key;
        if (selected.expanded) {
          this.presentation.collapsed.add(key);
          this.presentation.expandedHistory.delete(key);
        } else {
          this.presentation.collapsed.delete(key);
          if (selected.history && selected.depth === 0) this.presentation.expandedHistory.add(key);
        }
      } else if (selected && /^[1-9]$/.test(result.key)) {
        const shown = this.displayed;
        const action =
          shown?.row.key === selected.row.key
            ? shown.row.actions?.[shown.actionPage * 9 + Number(result.key) - 1]
            : undefined;
        if (action && shown) {
          const request = {
            key: shown.row.key,
            generation: shown.row.generation,
            revision: shown.row.revision,
            actionId: action.id,
          };
          if (action.confirmation !== undefined)
            this.confirmation = { request, text: action.confirmation };
          else this.options.close(request);
        }
      }
    } else if (result.action === "confirm" && selected) {
      this.shell.enterPane();
      if (this.shell.state.pane === "detail") this.loadDetails(selected.row);
    } else {
      const motion = listDetailMotionFromAction(result.action);
      if (motion) {
        const wasDetail = this.shell.state.pane === "detail";
        const changed = this.shell.applyMotion(motion, {
          rowCount: entries.length,
          hasSelection: !!selected,
        });
        if (changed._tag === "Close") this.options.close();
        else if (changed._tag === "Update") {
          if (changed.movedSelection)
            this.shell.select(
              changed.state.selected,
              entries.map((entry) => entry.row.key),
            );
          if (!wasDetail && changed.state.pane === "detail" && selected)
            this.loadDetails(selected.row);
        }
      }
    }
    this.options.requestRender();
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const { entries, selected } = this.selected();
    if (
      selected?.row.key !== this.displayed?.row.key ||
      selected?.row.generation !== this.displayed?.row.generation
    ) {
      this.actionPage = 0;
      this.preserveDetailPosition = false;
    }
    this.actionPage = Math.min(
      this.actionPage,
      Math.max(0, Math.ceil((selected?.row.actions?.length ?? 0) / 9) - 1),
    );
    this.displayed = selected ? { row: selected.row, actionPage: this.actionPage } : undefined;
    const tier = this.shell.syncLayout(width);
    const height = Math.max(1, this.options.height());
    const inner = Math.max(0, width - 2);
    const frame = listDetailFrame(this.options.theme);
    const urgent = needsYou(this.options.snapshot());
    const startup = activityStartupGlyph(
      this.options.snapshot(),
      this.options.starting?.() ?? 0,
      this.options.now?.(),
    );
    const hint = (id: FullScreenSelectionKeybindingId, fallback: string) =>
      filterReservedKeyLabel(
        this.options.keybindingLabel?.(id, fallback) ?? fallback,
        shortcuts,
        fallback,
      );
    const confirm = hint("tui.select.confirm", "Enter");
    const cancel = hint("tui.select.cancel", "Esc");
    const movement = `${hint("tui.select.up", "↑")}/${hint("tui.select.down", "↓")}`;
    const bottom = renderResponsiveManagerFooter(
      inner,
      this.confirmation
        ? [[`${confirm} confirm`, `${cancel} cancel`]]
        : [
            [
              `${movement} navigate`,
              `${confirm} details`,
              "c collapse",
              "f focus",
              "n needs you",
              "1-9 action",
              "r refresh",
              `${cancel} back`,
            ],
            ["c collapse", "f focus", "n needs you", "1-9 action"],
            [`${confirm} details`, `${cancel} back`],
          ],
    );
    const focus = this.options.snapshot().find((row) => row.key === this.presentation.focus);
    const breadcrumb = focus
      ? this.ancestorPath(focus)
          .map((row) => row.title)
          .join(" › ")
      : "";
    return framedScreen(frame, {
      width,
      height,
      top: ` Activity${breadcrumb ? ` › ${breadcrumb}` : ""}${urgent.length ? ` · Needs you ${urgent.length}` : ""}${startup ? ` ${startup}` : ""} `,
      bottom,
      body: (bodyHeight) => {
        if (this.confirmation)
          return framedFill(
            frame,
            wrapTextWithAnsi(this.confirmation.text, Math.max(1, inner)),
            bodyHeight,
            inner,
          );
        const listHeight =
          tier === "stacked" ? Math.max(1, Math.floor((bodyHeight - 1) / 2)) : bodyHeight;
        const detailWidth =
          tier === "wide" ? Math.max(1, inner - Math.floor(inner * 0.45) - 1) : Math.max(1, inner);
        const listWidth = tier === "wide" ? inner - detailWidth - 1 : inner;
        const showNeedsYou = urgent.length > 0 && listHeight > 1;
        const window = this.shell.visibleWindow(
          entries.length,
          listHeight - (showNeedsYou ? 1 : 0),
        );
        const list = entries.slice(window.start, window.end).map((entry) => {
          const prefix = `${entry.row.key === selected?.row.key ? ">" : " "}${entry.history ? "H " : ""}`;
          const content = `${prefix}${activityRowLine(entry, Math.max(0, listWidth - prefix.length), this.options.now?.(), this.options.theme)}`;
          const line = `${content}${" ".repeat(Math.max(0, listWidth - visibleWidth(content)))}`;
          if (entry.row.key !== selected?.row.key || !this.options.theme.bg) return line;
          // Width truncation emits full resets; restart selection background after each one.
          return line
            .split("\u001b[0m")
            .map((part) => this.options.theme.bg?.("selectedBg", part) ?? part)
            .join("\u001b[0m");
        });
        if (!list.length) list.push("No activity");
        if (showNeedsYou)
          list.unshift(
            this.options.theme.fg(
              "warning",
              `Needs you [n]: ${activityOwnerLabel(this.options.snapshot(), urgent[0]!, Math.max(0, listWidth - 15 - (urgent.length > 1 ? ` +${urgent.length - 1}`.length : 0)))}${urgent.length > 1 ? ` +${urgent.length - 1}` : ""}`,
            ),
          );
        const row = selected?.row;
        const sameItem =
          row &&
          this.loaded?.request.key === row.key &&
          this.loaded.request.generation === row.generation;
        const loaded = sameItem ? (this.loaded?.text ?? "") : (row?.detail ?? "");
        const freshness =
          sameItem && this.loaded?.request.revision !== row?.revision
            ? "Older output · r refresh"
            : "Output · r refresh";
        const now = this.options.now?.();
        const stale =
          now !== undefined && row?.updatedAt !== undefined
            ? `Updated ${Math.max(0, Math.floor((now - row.updatedAt) / 1000))}s ago`
            : "";
        const detailText = row
          ? [
              activityOwnerLabel(this.options.snapshot(), row),
              `${activityType(row)}${row.kind === "agent" && row.profile ? ` · ${row.profile}` : ""} · ${activityStatus(row)} · ${activityElapsed(row, now)}`,
              truncateToWidth(stale, detailWidth, "…"),
              row.summary ?? "",
              loaded,
              row.omittedChildren
                ? `At least ${row.omittedChildren} earlier completed items omitted.`
                : "",
              ...(row.actions ?? [])
                .slice(this.actionPage * 9, (this.actionPage + 1) * 9)
                .map((action, index) => `${index + 1} ${action.label}`),
              (row.actions?.length ?? 0) > 9 ? `a: more actions · page ${this.actionPage + 1}` : "",
            ].join("\n")
          : "Select an item";
        const detailHeight =
          tier === "stacked" ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight;
        const showFreshness = detailHeight > 1;
        const contentHeight = detailHeight - Number(showFreshness);
        const details = this.shell.detailWindow(
          detailText.split("\n").flatMap((line) => wrapTextWithAnsi(line, detailWidth)),
          contentHeight,
          this.preserveDetailPosition ? false : undefined,
        );
        if (contentHeight > 0) this.preserveDetailPosition = false;
        const detailRows = showFreshness
          ? [
              this.options.theme.fg("dim", truncateToWidth(freshness, detailWidth, "…")),
              ...details.visible,
            ]
          : details.visible;
        if (tier === "wide")
          return framedWideRows(frame, {
            left: list,
            right: detailRows,
            height: bodyHeight,
            listWidth,
            detailWidth,
          });
        if (tier === "stacked")
          return framedStackedRows(frame, {
            list,
            detail: detailRows,
            height: bodyHeight,
            inner,
          });
        return framedFill(frame, this.shell.state.details ? detailRows : list, bodyHeight, inner);
      },
    }).map((line) => truncateToWidth(line, width, ""));
  }
}
