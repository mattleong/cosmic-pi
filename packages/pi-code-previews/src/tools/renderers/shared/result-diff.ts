import type { Component } from "@earendil-works/pi-tui";
import type { RendererState } from "./types";

const RESULT_DIFF_SHOWN = "codePreviewResultDiffShown";

/** Records whether the result body draws the applied change's diff. */
export function setResultDiffShown(state: RendererState, shown: boolean): void {
  state[RESULT_DIFF_SHOWN] = shown;
}

/**
 * A finished change shows once: while the collapsed result draws its diff, the call omits the
 * proposed content. Expanded rows keep both, since expansion preserves the exact input. Pi renders the call before the result, so this decides when drawn, and creates the
 * content only when it is first shown.
 */
export function unlessResultDiffShown(state: RendererState, create: () => Component): Component {
  let content: Component | undefined;
  return {
    render(width) {
      if (state[RESULT_DIFF_SHOWN] === true) return [];
      content ??= create();
      return content.render(width);
    },
    invalidate() {
      content?.invalidate();
    },
  };
}
