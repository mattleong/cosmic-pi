import type { Component } from "@earendil-works/pi-tui";
import { headingShowedSubject } from "pi-code-previews";

/**
 * A body chosen as it draws, after the heading keyed by `headingState` reports whether it showed
 * its subject whole. It is built on first draw, again when that report changes, and again after
 * invalidation, so a theme change restyles it.
 */
export const subjectAwareComponent = (
  headingState: WeakKey | undefined,
  build: (subjectShown: boolean) => Component,
): Component => {
  let built: { readonly subjectShown: boolean; readonly component: Component } | undefined;
  return {
    render(width) {
      const subjectShown = headingState !== undefined && headingShowedSubject(headingState);
      if (built?.subjectShown !== subjectShown)
        built = { subjectShown, component: build(subjectShown) };
      return built.component.render(width);
    },
    invalidate() {
      built = undefined;
    },
  };
};
