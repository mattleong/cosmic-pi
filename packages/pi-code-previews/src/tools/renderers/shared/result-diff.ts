import type { Component } from "@earendil-works/pi-tui";
import type { RendererState } from "./types";

const RESULT_DIFF_SHOWN = "codePreviewResultDiffShown";

export function setResultDiffShown(state: RendererState, shown: boolean): void {
  state[RESULT_DIFF_SHOWN] = shown;
}

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
