import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { clipToWidth } from "pi-cosmic-ui/manager";

export const SELECTION_MARKER = "\x1b_ask-user-selection\x07";

export class DialogViewport {
  private offset = 0;
  private height = 24;
  private followSelection = true;
  private pending: "first" | "last" | number | undefined;

  follow(): void {
    this.followSelection = true;
    this.pending = undefined;
  }

  page(action: string): boolean {
    const direction = Fn.pipe(action, Str.endsWith("up")) ? -1 : 1;
    const distance = this.pending === "first" || this.pending === "last" ? 0 : (this.pending ?? 0);
    if (action === "first" || action === "last") this.pending = action;
    else if (action === "full-page-up" || action === "full-page-down")
      this.pending = distance + direction * Math.max(1, this.height - 2);
    else if (action === "half-page-up" || action === "half-page-down")
      this.pending = distance + direction * Math.max(1, Math.floor((this.height - 2) / 2));
    else return false;
    this.followSelection = false;
    return true;
  }

  private applyPending(maximum: number): void {
    if (this.pending === "first") this.offset = 0;
    else if (this.pending === "last") this.offset = maximum;
    else if (this.pending !== undefined) this.offset += this.pending;
    this.pending = undefined;
    this.offset = Math.max(0, Math.min(maximum, this.offset));
  }

  private revealFocus(lines: readonly string[], bodyHeight: number): void {
    const cursor = Option.getOrElse(
      Arr.findFirstIndex(lines, Str.includes(CURSOR_MARKER)),
      () => -1,
    );
    const selected = Option.getOrElse(
      Arr.findFirstIndex(lines, Str.includes(SELECTION_MARKER)),
      () => -1,
    );
    const focus = cursor >= 0 ? cursor : this.followSelection ? selected : -1;
    if (focus < 0) return;
    if (focus < this.offset) this.offset = focus;
    if (focus >= this.offset + bodyHeight) this.offset = focus - bodyHeight + 1;
  }

  render(lines: readonly string[], width: number, height: number, feedback?: string): string[] {
    if (width < 1 || height < 1) return [];
    const h = Number.isFinite(height) ? Math.floor(height) : lines.length;
    this.height = h;
    const bodyHeight = lines.length > h && h > 1 ? h - 1 : h;
    this.applyPending(Math.max(0, lines.length - bodyHeight));
    this.revealFocus(lines, bodyHeight);
    const visible = lines.slice(this.offset, this.offset + bodyHeight);
    if (bodyHeight < h)
      visible.push(
        feedback ??
          `${this.offset + 1}-${this.offset + visible.length}/${lines.length} • PgUp/PgDn scroll • Home/End`,
      );
    return Arr.map(visible, (line) => {
      const clean = Fn.pipe(line, Str.replaceAll(SELECTION_MARKER, ""));
      const bounded = clipToWidth(clean, width, "");
      const marker = Fn.pipe(clean, Str.indexOf(CURSOR_MARKER));
      return Option.isSome(marker) && !Fn.pipe(bounded, Str.includes(CURSOR_MARKER))
        ? CURSOR_MARKER +
            clipToWidth(Fn.pipe(clean, Str.slice(marker.value + CURSOR_MARKER.length)), width, "")
        : bounded;
    });
  }
}
