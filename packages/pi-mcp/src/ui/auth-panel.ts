import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { managerActivityGlyph, renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import { framedFill, framedScreen, listDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import {
  FullScreenKeymap,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keymap";
import {
  authCanReopen,
  authPhaseLabel,
  authPhaseTerminal,
  type McpAuthProgress,
} from "../auth/progress.ts";
import { mcpDiagnostic } from "../client/diagnostics.ts";

export interface McpAuthPanelOptions {
  readonly snapshot: () => McpAuthProgress;
  readonly now: () => number;
  readonly theme: Theme;
  readonly act: (action: "cancel" | "reopen") => void;
  readonly matchesKeybinding: (data: string, id: FullScreenSelectionKeybindingId) => boolean;
  readonly keyLabel: (id: FullScreenSelectionKeybindingId, fallback: string) => string;
}
const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Synchronous, display-only projection. Auth values and services never reach this component. */
export class McpAuthPanel implements Component {
  private readonly keys = new FullScreenKeymap();
  private selected = 0;
  private readonly options: McpAuthPanelOptions;
  constructor(options: McpAuthPanelOptions) {
    this.options = options;
  }
  invalidate(): void {}
  handleInput(data: string): void {
    const value = this.options.snapshot();
    const action = this.keys.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (action?._tag !== "Action") return;
    if (action.action === "cancel" || action.action === "quit") this.options.act("cancel");
    else if (action.action === "up" || action.action === "down" || action.action === "next-pane")
      this.selected = 1 - this.selected;
    else if (action.action === "confirm")
      this.options.act(
        this.selected === 1 && authCanReopen(value, this.options.now()) ? "reopen" : "cancel",
      );
  }
  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const inner = Math.max(0, safeWidth - 2);
    const { theme } = this.options;
    const value = this.options.snapshot();
    const now = authPhaseTerminal(value.phase) ? value.updatedAt : this.options.now();
    const terminal = authPhaseTerminal(value.phase);
    const canReopen = authCanReopen(value, now);
    const state =
      value.phase === "succeeded"
        ? "done"
        : value.phase === "failed"
          ? "failed"
          : value.phase === "cancelled"
            ? "stopped"
            : value.phase === "cancelling"
              ? "stopping"
              : "running";
    const color =
      value.phase === "failed"
        ? "error"
        : value.phase === "succeeded"
          ? "success"
          : value.phase === "cancelling"
            ? "warning"
            : "accent";
    const lines = [
      theme.fg(
        color,
        `${managerActivityGlyph(state, Math.floor(now / 200))} ${authPhaseLabel(value.phase)}`,
      ),
      `Elapsed ${duration(now - value.startedAt)}`,
    ];
    if (value.deadline !== undefined && !terminal)
      lines.push(`Current deadline in ${duration(value.deadline - now)}`);
    if (value.phase === "awaiting-callback")
      lines.push(
        value.mode === "manual"
          ? "Use the private browser and callback dialogs."
          : "Approve in your browser, then return here.",
      );
    if (value.reason || value.failureKind) {
      const diagnostic = mcpDiagnostic(
        {
          kind: value.failureKind ?? "unavailable",
          outcome: "not-sent",
          reason: value.reason,
        },
        { canReopen },
      );
      lines.push(
        "",
        theme.fg(diagnostic.severity === "error" ? "error" : "warning", diagnostic.explanation),
      );
    }
    lines.push("", `${this.selected === 0 ? "> " : "  "}${terminal ? "Close" : "Cancel sign-in"}`);
    if (canReopen) lines.push(`${this.selected === 1 ? "> " : "  "}Reopen browser`);
    const footer = renderResponsiveManagerFooter(Math.max(0, inner - 2), [
      [
        `${this.options.keyLabel("tui.select.confirm", "Enter")} choose`,
        `${this.options.keyLabel("tui.select.cancel", "Esc")} ${terminal ? "close" : "cancel"}`,
      ],
    ]);
    // Docked sign-in panels keep their existing chrome, outside the manager color rules.
    const frame = {
      ...listDetailFrame(theme),
      outer: (text: string) => theme.fg("borderAccent", text),
    };
    const body = new Text(lines.join("\n"), 1, 1).render(Math.max(1, inner));
    return framedScreen(frame, {
      width: safeWidth,
      height: body.length + 2,
      top: ` ${theme.bold(`Sign in to ${sanitizeTerminalLine(value.server)}`)} `,
      bottom: theme.fg("dim", ` ${footer} `),
      body: (height) => framedFill(frame, body, height, inner),
    });
  }
}
