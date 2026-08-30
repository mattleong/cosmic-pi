import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type * as MutableRef from "effect/MutableRef";
import { createFooterPresenter } from "pi-cosmic-core";
import type { ResolvedConfig } from "../config/index.ts";
import { visibleStatusLine, type XaiProjection } from "../usage/projection.ts";

const STATUS_KEY = "better-xai";

export function createFooterController(deps: {
  config(ctx: ExtensionContext): ResolvedConfig;
  projection: MutableRef.MutableRef<XaiProjection>;
  hasTerminalUI(ctx: ExtensionContext): boolean;
}) {
  const { config, projection, hasTerminalUI } = deps;
  return createFooterPresenter({
    statusKey: STATUS_KEY,
    footerMode: (ctx) => config(ctx).footer.mode,
    hasTerminalUI,
    statusText: () => visibleStatusLine(projection),
    renderLines: ({ theme, width }) => {
      const usageStatusLine = visibleStatusLine(projection);
      if (!usageStatusLine) return [];
      return [truncateToWidth(theme.fg("dim", usageStatusLine), width, theme.fg("dim", "..."))];
    },
  });
}
