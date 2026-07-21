import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config.ts";
import { truncateToWidth } from "../format.ts";
import { STATUS_KEY } from "../identity.ts";
import type * as MutableRef from "effect/MutableRef";
import { visibleStatusLine, type XaiProjection } from "../usage-controller.ts";

export interface FooterController {
  update(ctx: ExtensionContext): void;
}

function invokeHostCallback<A>(callback: () => A, fallback: A): A {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

export function createFooterController(deps: {
  config(ctx: ExtensionContext): ResolvedConfig;
  projection: MutableRef.MutableRef<XaiProjection>;
  hasTerminalUI(ctx: ExtensionContext): boolean;
}): FooterController {
  const { config, projection, hasTerminalUI } = deps;
  let footerInstalled = false;
  let footerGeneration = 0;
  let requestFooterRender: (() => void) | undefined;
  let statusInstalled = false;

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      invokeHostCallback(() => requestFooterRender?.(), undefined);
      return;
    }
    const generation = ++footerGeneration;
    let committed = false;
    let disposed = false;
    let stagedRequestRender: (() => void) | undefined;
    const installed = invokeHostCallback(() => {
      ctx.ui.setFooter((tui, theme) => {
        const requestRender = () => invokeHostCallback(() => tui.requestRender(), undefined);
        if (committed && footerGeneration === generation) requestFooterRender = requestRender;
        else stagedRequestRender = requestRender;
        return {
          dispose: () => {
            disposed = true;
            if (footerGeneration !== generation) return;
            footerInstalled = false;
            requestFooterRender = undefined;
          },
          invalidate() {},
          render(width: number): string[] {
            return invokeHostCallback(() => {
              const usageStatusLine = visibleStatusLine(projection);
              if (!usageStatusLine) return [];
              return [
                truncateToWidth(theme.fg("dim", usageStatusLine), width, theme.fg("dim", "...")),
              ];
            }, []);
          },
        };
      });
      return true;
    }, false);
    if (!installed) {
      requestFooterRender = undefined;
      return;
    }
    committed = true;
    if (disposed || footerGeneration !== generation) return;
    footerInstalled = true;
    requestFooterRender = stagedRequestRender;
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    const generation = footerGeneration;
    const removed = invokeHostCallback(() => {
      ctx.ui.setFooter(undefined);
      return true;
    }, false);
    if (!removed || footerGeneration !== generation) return;
    footerGeneration++;
    footerInstalled = false;
    requestFooterRender = undefined;
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    const updated = invokeHostCallback(() => {
      ctx.ui.setStatus(STATUS_KEY, text);
      return true;
    }, false);
    if (!updated) return;
    statusInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    invokeHostCallback(() => {
      const cfg = config(ctx);
      const line = visibleStatusLine(projection);
      if (!hasTerminalUI(ctx)) {
        if (cfg.footer.mode === "off") {
          setStatus(ctx, undefined);
          return;
        }
        setStatus(ctx, line);
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

      setStatus(ctx, line);
    }, undefined);
  }

  return { update: updateFooter };
}
