import type { Theme } from "@earendil-works/pi-coding-agent";
import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import { Input, wrapTextWithAnsi, type Component, type Focusable } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter, clipToWidth } from "pi-cosmic-ui/manager";
import {
  FULL_SCREEN_NAVIGATION_SHORTCUTS,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keymap";
import { filterReservedKeyLabel, filterTextInputKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import {
  listDetailMotionFromAction,
  detailWindowPositionLabel,
  stackedListHeight,
  wideListDetailGeometry,
} from "pi-cosmic-ui/manager/list-detail";
import {
  ListDetailShell,
  framedFill,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import { SearchableSelectPage } from "pi-cosmic-ui/manager/searchable-select";
import { sanitizeTerminalLine, countLabel } from "pi-cosmic-core";
import type {
  McpCachedDetail,
  McpCachedEntry,
  McpCachedPage,
  McpCachedRef,
  McpCachedRequest,
} from "../discovery/model.ts";
import type { McpManagerSnapshot } from "../manager/model.ts";
import { actionMenu } from "./actions.ts";
import {
  browserDetail,
  browserCatalogStatus,
  browserEmpty,
  browserIdentity,
  browserLabel,
  cachedFamilies,
} from "./browser.ts";
import { dashboardDetail, dashboardRows, dashboardTable } from "./dashboard.ts";
import type { McpManagerClose, McpManagerSelection } from "./manager-state.ts";
import { McpResultNavigation, type McpResultPage } from "./result-view.ts";

export type McpViewRequest =
  | {
      readonly kind: "cached";
      readonly request: McpCachedRequest;
      readonly deliver: (page: McpCachedPage | undefined) => void;
    }
  | {
      readonly kind: "detail";
      readonly ref: McpCachedRef;
      readonly deliver: (detail: McpCachedDetail | undefined) => void;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly offset: number;
      readonly deliver: (page: McpResultPage | undefined) => void;
    };
export interface McpManagerComponentOptions {
  readonly theme: Theme;
  readonly snapshot: () => McpManagerSnapshot;
  readonly selection: McpManagerSelection;
  readonly height: () => number;
  readonly requestRender: () => void;
  readonly load: (request: McpViewRequest) => void;
  readonly finish: (action: McpManagerClose | undefined) => void;
  readonly matchesKeybinding: (data: string, id: FullScreenSelectionKeybindingId) => boolean;
  readonly keybindingLabel: (id: FullScreenSelectionKeybindingId, fallback: string) => string;
}

const managerShortcuts = new Set(["a", "b", "s", "[", "]", "n", "p", "v"]);
const reservedLabels = new Set([...FULL_SCREEN_NAVIGATION_SHORTCUTS, ...managerShortcuts]);

/** Pure component. Callbacks enqueue local reads; neither rendering nor navigation performs I/O. */
export class McpManagerComponent implements Component, Focusable {
  private readonly options: McpManagerComponentOptions;
  private readonly shell = new ListDetailShell();
  private readonly input = new Input();
  private selection: McpManagerSelection;
  private searching = false;
  private _focused = false;
  private menu: (Component & Focusable) | undefined;
  private page: McpCachedPage | undefined;
  private detail: McpCachedDetail | undefined;
  // Navigation intent only. Revocation always clears the actual metadata text.
  private expandedId: string | undefined;
  private generation = 0;
  private readonly cursors: Array<string | undefined> = [];
  private cursor: string | undefined;
  private readonly result = new McpResultNavigation();
  private resultOffset = 0;
  private unavailable = false;
  private disposed = false;
  private moreHelp = false;
  /** An action that asks first, shown in place of the list until confirmed or cancelled. */
  private confirmation: McpManagerClose | undefined;

  constructor(options: McpManagerComponentOptions) {
    this.options = options;
    this.selection = options.selection;
    this.input.setValue(this.selection.query);
    this.update();
    if (this.selection.screen === "result")
      this.shell.applyMotion("forward", { rowCount: 0, hasSelection: true });
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.searching;
    if (this.menu) this.menu.focused = value;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.menu = undefined;
    this.confirmation = undefined;
    this.generation += 1;
    this.page = undefined;
    this.detail = undefined;
    this.result.unavailable();
  }
  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
  private selectedRows() {
    return dashboardRows(this.options.snapshot(), this.selection.query);
  }
  private ids(): ReadonlyArray<string> {
    if (this.selection.screen === "result") return [];
    return this.selection.screen === "browse"
      ? (this.page?.entries.map(browserIdentity) ?? [])
      : this.selectedRows().map((row) => row.id);
  }
  /** Revocation clears text synchronously. A coalesced local read may replace it later. */
  update(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.page = undefined;
    this.detail = undefined;
    this.result.invalidate();
    this.load();
    this.requestRender();
  }
  private load(): void {
    const generation = ++this.generation;
    const active = () => !this.disposed && generation === this.generation;
    if (this.selection.screen === "browse") {
      const request: McpCachedRequest = {
        family: this.selection.family,
        query: this.selection.query,
        limit: 40,
      };
      if (this.selection.server) Object.assign(request, { server: this.selection.server });
      if (this.cursor) Object.assign(request, { cursor: this.cursor });
      this.options.load({
        kind: "cached",
        request,
        deliver: (page) => {
          if (!active()) return;
          if (!page && this.cursor) {
            this.cursor = undefined;
            this.cursors.length = 0;
            this.load();
            return;
          }
          this.page = page;
          this.reconcile();
          const selected = page?.entries[this.shell.state.selected];
          if (selected && browserIdentity(selected) === this.expandedId) this.loadDetail(selected);
          else this.expandedId = undefined;
          this.requestRender();
        },
      });
    } else if (this.selection.screen === "result" && this.selection.resultId)
      this.readResult(this.resultOffset, "current", generation);
    else this.reconcile();
  }
  private reconcile(): void {
    const ids = this.ids();
    if (this.selection.selected && ids.includes(this.selection.selected))
      this.shell.select(ids.indexOf(this.selection.selected), ids);
    else this.shell.reconcile(ids);
    this.shell.ensureSelectionPane(ids.length > 0);
    this.selection = { ...this.selection, selected: this.shell.state.selectedId };
  }
  private readResult(
    offset: number,
    direction: "current" | "previous" | "next",
    generation = ++this.generation,
  ): void {
    const id = this.selection.resultId;
    if (!id) return;
    this.options.load({
      kind: "result",
      id,
      offset,
      deliver: (page) => {
        if (this.disposed || generation !== this.generation) return;
        const snapshot = this.options.snapshot();
        if (!snapshot.trusted || !snapshot.enabled) return;
        this.unavailable = !page;
        if (page) {
          this.result.accept(page, direction);
          this.resultOffset = page.offset;
        } else this.result.unavailable();
        if (direction !== "current" || !page) {
          this.shell.resetDetailWindow();
          this.shell.resetDetailScroll();
        }
        this.requestRender();
      },
    });
  }
  private inspect(): void {
    this.shell.applyMotion("forward", { rowCount: this.ids().length, hasSelection: true });
    if (this.selection.screen === "browse") {
      const entry = this.page?.entries[this.shell.state.selected];
      if (!entry) return;
      this.expandedId = browserIdentity(entry);
      this.loadDetail(entry);
    }
  }
  private loadDetail(entry: McpCachedEntry): void {
    const generation = ++this.generation;
    this.detail = undefined;
    this.options.load({
      kind: "detail",
      ref: entry.ref,
      deliver: (detail) => {
        if (
          !this.disposed &&
          generation === this.generation &&
          this.selection.selected === browserIdentity(entry)
        ) {
          this.detail = detail;
          if (!detail) this.expandedId = undefined;
          this.requestRender();
        }
      },
    });
  }
  private actionRow() {
    return this.selection.screen === "browse"
      ? this.options
          .snapshot()
          .servers.find(
            (server) =>
              server.id ===
              (this.page?.entries[this.shell.state.selected]?.ref.server ?? this.selection.server),
          )
      : this.selectedRows()[this.shell.state.selected];
  }
  private actions(): void {
    const row = this.actionRow();
    if (!row) return;
    this.menu = new SearchableSelectPage({
      ...this.menuHost(),
      breadcrumb: "MCP actions",
      title: sanitizeTerminalLine(row.id),
      subtitle: "Enter chooses an action. Blocked actions explain why.",
      ...actionMenu(row),
      select: (action) => {
        this.menu = undefined;
        if (action === "browse") {
          this.selection = {
            ...this.selection,
            screen: "browse",
            server: row.id,
            query: "",
            selected: undefined,
          };
          this.input.setValue("");
          this.restartBrowse();
        } else {
          const warning = row.actions.find((choice) => choice.action === action)?.confirmation;
          const close = { action, row, selection: this.selection, confirmed: warning };
          if (warning === undefined) this.options.finish(close);
          else this.confirmation = close;
        }
        this.requestRender();
      },
    });
    this.menu.focused = this._focused;
  }
  private menuHost() {
    return {
      theme: this.options.theme,
      getHeight: this.options.height,
      requestRender: () => this.requestRender(),
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      cancel: () => {
        this.menu = undefined;
        this.requestRender();
      },
    };
  }
  private restartBrowse(): void {
    this.cursor = undefined;
    this.cursors.length = 0;
    this.update();
  }
  private serverFilter(): void {
    this.menu = new SearchableSelectPage({
      ...this.menuHost(),
      breadcrumb: "MCP cached metadata",
      title: "Server filter",
      subtitle: "Filtering does not connect.",
      choices: [
        {
          value: "*",
          payload: undefined,
          item: { value: "*", label: "All permitted cached servers" },
          searchText: "all",
        },
        ...this.options.snapshot().servers.map((row) => ({
          value: row.id,
          payload: row.id,
          item: { value: row.id, label: sanitizeTerminalLine(row.id) },
          searchText: row.id,
        })),
      ],
      select: (server) => {
        this.menu = undefined;
        this.selection = { ...this.selection, server, selected: undefined };
        this.restartBrowse();
      },
    });
    this.menu.focused = this._focused;
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.menu) {
      this.menu.handleInput?.(data);
      return;
    }
    if (this.confirmation) {
      const answer = this.shell.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (answer?._tag === "Action" && answer.action === "confirm")
        this.options.finish(this.confirmation);
      else if (
        answer?._tag === "Action" &&
        (answer.action === "cancel" || answer.action === "quit")
      )
        this.confirmation = undefined;
      this.requestRender();
      return;
    }
    const resolution = this.shell.keymap.resolve(data, {
      mode: this.searching ? "search" : "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: managerShortcuts,
    });
    if (resolution?._tag === "Shortcut") {
      if (resolution.key === "a" && this.selection.screen !== "result") this.actions();
      else if (resolution.key === "b" && this.selection.screen === "dashboard") {
        this.selection = {
          ...this.selection,
          screen: "browse",
          query: "",
          server: undefined,
          selected: undefined,
        };
        this.input.setValue("");
        this.update();
      } else if (resolution.key === "s" && this.selection.screen === "browse") this.serverFilter();
      else if (
        (resolution.key === "[" || resolution.key === "]") &&
        this.selection.screen === "browse"
      ) {
        const index = cachedFamilies.indexOf(this.selection.family);
        this.selection = {
          ...this.selection,
          family: cachedFamilies[(index + (resolution.key === "]" ? 1 : 3)) % 4]!,
          selected: undefined,
        };
        this.restartBrowse();
      } else if (resolution.key === "v" && this.selection.screen === "result") {
        if (this.result.toggleMode()) {
          this.shell.resetDetailWindow();
          this.shell.resetDetailScroll();
        }
      } else if (resolution.key === "n") {
        if (this.selection.screen === "browse" && this.page?.next) {
          this.cursors.push(this.cursor);
          if (this.cursors.length > 128) this.cursors.shift();
          this.cursor = this.page.next;
          this.page = undefined;
          this.detail = undefined;
          this.load();
        } else if (this.selection.screen === "result" && this.result.nextOffset !== undefined)
          this.readResult(this.result.nextOffset, "next");
      } else if (resolution.key === "p") {
        if (this.selection.screen === "browse" && this.cursors.length) {
          this.cursor = this.cursors.pop();
          this.page = undefined;
          this.detail = undefined;
          this.load();
        } else if (this.selection.screen === "result" && this.result.previousOffset !== undefined)
          this.readResult(this.result.previousOffset, "previous");
      }
    } else if (resolution?._tag === "Action") {
      const action = resolution.action;
      if (action === "search" && this.selection.screen !== "result") {
        this.searching = true;
        this.focused = this._focused;
      } else if (this.searching && action === "cancel") {
        this.searching = false;
        this.focused = this._focused;
      } else if (this.selection.screen === "result" && (action === "cancel" || action === "back"))
        this.options.finish(undefined);
      else if (action === "confirm") {
        if (this.selection.screen !== "result") this.inspect();
      } else if (action === "help") this.moreHelp = !this.moreHelp;
      else {
        const motion = listDetailMotionFromAction(action);
        if (motion) {
          const result = this.shell.applyMotion(motion, {
            rowCount: this.ids().length,
            hasSelection: this.ids().length > 0 || this.selection.screen === "result",
          });
          if (result._tag === "Close") this.options.finish(undefined);
          else if (result._tag === "Update" && result.movedSelection) {
            this.shell.select(result.state.selected, this.ids());
            this.selection = { ...this.selection, selected: this.shell.state.selectedId };
            this.detail = undefined;
            this.expandedId = undefined;
            this.shell.resetDetailWindow();
          }
        }
      }
    } else if (this.searching) {
      this.input.handleInput(data);
      const value = this.input.getValue();
      const query = value.slice(0, 512);
      if (query !== value) this.input.setValue(query);
      if (query !== this.selection.query) {
        this.selection = { ...this.selection, query };
        this.restartBrowse();
      }
    }
    this.requestRender();
  }
  render(width: number): string[] {
    if (this.menu) return this.menu.render(width);
    if (this.disposed || width < 4) return [];
    const theme = this.options.theme;
    const listFocused = !this.searching && this.shell.state.pane === "list";
    const frame = listDetailFrame(
      theme,
      this.searching
        ? undefined
        : this.selection.screen === "result"
          ? "detail"
          : this.shell.state.pane,
    );
    const snapshot = this.options.snapshot();
    if (!snapshot.trusted || !snapshot.enabled) {
      this.generation += 1;
      this.page = undefined;
      this.detail = undefined;
      this.result.invalidate();
    }
    const layout = this.shell.syncLayout(width);
    const inner = width - 2;
    const header =
      this.selection.screen === "dashboard"
        ? ` /mcp · ${snapshot.active} active · ${snapshot.queued} queued `
        : this.selection.screen === "browse"
          ? ` /mcp · ${this.selection.family} · ${sanitizeTerminalLine(this.selection.server ?? "all servers")} · ${countLabel(this.page?.total ?? 0, "match", "matches")} `
          : " /mcp · saved output ";
    const label = (id: FullScreenSelectionKeybindingId, fallback: string) => {
      const configured = this.options.keybindingLabel(id, fallback);
      return this.searching
        ? filterTextInputKeyLabel(configured, fallback)
        : filterReservedKeyLabel(configured, reservedLabels, fallback);
    };
    const enter = label("tui.select.confirm", "Enter");
    const cancel = label("tui.select.cancel", "Esc");
    // Esc leaves a detail pane; from a list or a saved result it closes the screen.
    const escape = `${cancel} ${this.selection.screen !== "result" && this.shell.state.pane === "detail" ? "Back" : "Close"}`;
    const movement = `${label("tui.select.up", "↑")}/${label("tui.select.down", "↓")}/j/k Move`;
    const paging = `${label("tui.select.pageUp", "PgUp")}/${label("tui.select.pageDown", "PgDn")} Page`;
    const resultMode = this.result.hasReadable
      ? `v ${this.result.mode === "readable" ? "Raw" : "Readable"} · `
      : "";
    const primary =
      this.selection.screen === "result"
        ? `${resultMode}n/p Pages · q Close`
        : this.actionRow()
          ? `${enter} Inspect · a Actions · / Search`
          : this.selection.screen === "browse"
            ? "/ Search · s Server"
            : "b Browse · / Search";
    const confirming = this.confirmation;
    const warning = confirming?.confirmed;
    if (confirming && warning !== undefined)
      return framedScreen(frame, {
        width,
        height: Math.max(3, this.options.height()),
        top: clipToWidth(` /mcp · ${sanitizeTerminalLine(confirming.row.id)} `, inner, ""),
        bottom: renderResponsiveManagerFooter(inner, [[`${enter} Confirm`, `${cancel} Cancel`]]),
        body: (height) =>
          framedFill(
            frame,
            [
              theme.bold(sanitizeTerminalLine(confirming.row.id)),
              "",
              ...wrapTextWithAnsi(warning, Math.max(1, inner)),
            ],
            height,
            inner,
          ),
      });
    const footer = renderResponsiveManagerFooter(
      inner,
      this.moreHelp
        ? [
            [
              `${movement} · C-u/d Half · ${paging} · gg/G Ends`,
              `${this.selection.screen === "result" ? resultMode : ""}${escape} · q Close`,
            ],
          ]
        : [
            [
              primary,
              this.selection.screen === "browse"
                ? "[ ] Family · s Server · n/p Pages"
                : this.selection.screen === "result"
                  ? `? More · ${escape}`
                  : `b Browse · ? More · ${escape}`,
            ],
            [
              this.selection.screen === "result"
                ? `${resultMode}n/p Pages`
                : this.actionRow()
                  ? `${enter} Inspect · a Actions`
                  : this.selection.screen === "browse"
                    ? "s Server"
                    : "b Browse",
              escape,
            ],
          ],
    );
    return framedScreen(frame, {
      width,
      height: Math.max(3, this.options.height()),
      top: clipToWidth(header, inner, ""),
      bottom: footer,
      body: (height) => {
        const search = this.searching
          ? this.input
              .render(inner)
              .slice(0, 1)
              .map((line) => focusedField(theme, line))
          : [];
        const selectedServer = this.page?.entries[this.shell.state.selected]?.ref.server;
        const catalog =
          this.selection.screen === "browse"
            ? this.page?.catalogs.find((value) => value.server === selectedServer)
            : undefined;
        const prefix = [
          ...search,
          ...(catalog ? [clipToWidth(browserCatalogStatus(catalog), inner, "")] : []),
        ].slice(0, height);
        const bodyHeight = Math.max(0, height - prefix.length);
        const wide = layout === "wide" && this.selection.screen !== "result";
        const stacked =
          layout === "stacked" && bodyHeight >= 6 && this.selection.screen !== "result";
        const listHeight = stacked
          ? Math.min(bodyHeight, stackedListHeight(bodyHeight, this.ids().length))
          : bodyHeight;
        const detailHeight = stacked ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight;
        const geometry = wideListDetailGeometry(width, 24, 0.45);
        const table =
          this.selection.screen === "dashboard"
            ? dashboardTable(
                snapshot.servers,
                wide ? geometry.listWidth : inner,
                theme,
                listFocused,
              )
            : undefined;
        const columnHeader = table && listHeight > 1 ? [table.header] : [];
        const labels =
          this.selection.screen === "browse"
            ? (this.page?.entries.map((entry, index) =>
                index === this.shell.state.selected && listFocused
                  ? focusedField(theme, `> ${browserLabel(entry)}`)
                  : theme.fg(
                      managerTone.identity,
                      `${index === this.shell.state.selected ? "> " : "  "}${browserLabel(entry)}`,
                    ),
              ) ?? [])
            : table
              ? this.selectedRows().map((row, index) =>
                  table.row(row, index === this.shell.state.selected),
                )
              : [];
        const window = this.shell.visibleWindow(labels.length, listHeight - columnHeader.length);
        const left = [...columnHeader, ...labels.slice(window.start, window.end)];
        if (!labels.length)
          left.push(
            ...(this.selection.screen === "browse"
              ? browserEmpty(this.page, this.selection.server)
              : "No MCP servers configured"
            ).split("\n"),
          );
        const details =
          this.selection.screen === "dashboard"
            ? dashboardDetail(
                this.selectedRows()[this.shell.state.selected],
                theme,
                this.shell.state.pane === "detail",
              )
            : this.selection.screen === "browse"
              ? browserDetail(
                  this.page?.entries[this.shell.state.selected],
                  this.detail,
                  theme,
                  this.shell.state.pane === "detail",
                )
              : (this.result.renderLines(theme) ?? [
                  this.unavailable
                    ? "Result unavailable. It may have been evicted or revoked. The source operation was not replayed."
                    : "Reading authorized retained output locally.",
                ]);
        const detailWidth = wide ? geometry.detailWidth : inner;
        const lines = details.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, detailWidth)));
        const awaitingDetail =
          this.selection.screen === "browse"
            ? this.expandedId !== undefined && !this.detail
            : this.selection.screen === "result" && !this.result.page && !this.unavailable;
        // Loading/withdrawal placeholders must not clamp the authorized viewport to zero.
        const detailWindow = awaitingDetail
          ? undefined
          : this.shell.detailWindow(lines, detailHeight, false);
        const right = detailWindow
          ? [
              ...(detailWindow.overflow
                ? [theme.fg("dim", detailWindowPositionLabel(detailWindow.overflow))]
                : []),
              ...detailWindow.visible,
            ]
          : lines.slice(0, detailHeight);
        const body = wide
          ? framedWideRows(frame, {
              left,
              right,
              height: bodyHeight,
              listWidth: geometry.listWidth,
              detailWidth,
            })
          : stacked
            ? framedStackedRows(frame, { list: left, detail: right, height: bodyHeight, inner })
            : framedFill(
                frame,
                this.shell.state.details ||
                  this.shell.state.pane === "detail" ||
                  this.selection.screen === "result"
                  ? right
                  : left,
                bodyHeight,
                inner,
                this.selection.screen === "result" ? "detail" : this.shell.state.pane,
              );
        return [...framedFill(frame, prefix, prefix.length, inner), ...body];
      },
    });
  }
  invalidate(): void {
    this.input.invalidate();
    this.menu?.invalidate();
  }
}
