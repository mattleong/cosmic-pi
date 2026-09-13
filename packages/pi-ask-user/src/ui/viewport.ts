import { CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";

/** Internal row annotation, removed before handing lines to Pi. */
export const SELECTION_MARKER = "\x1b_ask-user-selection\x07";

/** An outer viewport for components, including Editor, without a height setter. */
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
    const direction = action.endsWith("up") ? -1 : 1;
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

  render(lines: readonly string[], width: number, height: number, feedback?: string): string[] {
    if (width < 1 || height < 1) return [];
    const h = Number.isFinite(height) ? Math.floor(height) : lines.length;
    this.height = h;
    const bodyHeight = lines.length > h && h > 1 ? h - 1 : h;
    const maximum = Math.max(0, lines.length - bodyHeight);
    if (this.pending === "first") this.offset = 0;
    else if (this.pending === "last") this.offset = maximum;
    else if (this.pending !== undefined) this.offset += this.pending;
    this.pending = undefined;
    this.offset = Math.max(0, Math.min(maximum, this.offset));
    const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    const selected = lines.findIndex((line) => line.includes(SELECTION_MARKER));
    const focus = cursor >= 0 ? cursor : this.followSelection ? selected : -1;
    if (focus >= 0) {
      if (focus < this.offset) this.offset = focus;
      if (focus >= this.offset + bodyHeight) this.offset = focus - bodyHeight + 1;
    }
    const visible = lines.slice(this.offset, this.offset + bodyHeight);
    if (bodyHeight < h)
      visible.push(
        feedback ??
          `${this.offset + 1}-${this.offset + visible.length}/${lines.length} • PgUp/PgDn scroll • Home/End`,
      );
    return visible.map((line) => {
      const clean = line.replaceAll(SELECTION_MARKER, "");
      const bounded = truncateToWidth(clean, width, "");
      const marker = clean.indexOf(CURSOR_MARKER);
      // Editor's minimum padding can exceed a one-column allocation. Shift its
      // cursor cell into view rather than dropping the IME anchor at that width.
      return marker >= 0 && !bounded.includes(CURSOR_MARKER)
        ? CURSOR_MARKER + truncateToWidth(clean.slice(marker + CURSOR_MARKER.length), width, "")
        : bounded;
    });
  }
}
