import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { truncateToWidth } from "../format.ts";
import { STATUS_KEY } from "../identity.ts";
import type { UsageController } from "../usage-controller.ts";

export interface FooterController {
  update(ctx: ExtensionContext): void;
}

export function createFooterController(deps: {
  config(ctx: ExtensionContext): ResolvedConfig;
  usageController: UsageController;
  hasTerminalUI(ctx: ExtensionContext): boolean;
}): FooterController {
  const { config, usageController, hasTerminalUI } = deps;
  let footerInstalled = false;
  let requestFooterRender: (() => void) | undefined;
  let statusInstalled = false;

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      requestFooterRender?.();
      return;
    }
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme) => {
      requestFooterRender = () => tui.requestRender();
      return {
        dispose: () => {
          footerInstalled = false;
          requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const cfg = config(ctx);
          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          const usageStatusLine = usageController.statusLine(ctx, cfg, usingSubscription);
          if (!usageStatusLine) return [];
          return [truncateToWidth(theme.fg("dim", usageStatusLine), width, theme.fg("dim", "..."))];
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
    requestFooterRender = undefined;
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    statusInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    const cfg = config(ctx);
    if (!hasTerminalUI(ctx)) {
      if (cfg.footer.mode === "off") {
        setStatus(ctx, undefined);
        return;
      }
      setStatus(ctx, usageController.statusLine(ctx, cfg) || undefined);
      return;
    }

    if (cfg.footer.mode === "replace") {
      setStatus(ctx, undefined);
      installFooter(ctx);
      return;
    }

    clearFooter(ctx);
    if (cfg.footer.mode === "off") {
      setStatus(ctx, undefined);
      return;
    }

    setStatus(ctx, usageController.statusLine(ctx, cfg) || undefined);
  }

  return { update: updateFooter };
}
