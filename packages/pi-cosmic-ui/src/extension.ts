import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config/store.ts";
import type { ResolvedCosmicUiConfig } from "./config/schema.ts";
import { createFooterComponent, type FooterTotals } from "./footer/component.ts";
import { applyGitNumstat, parseGitStatus, type FooterGitStatus } from "./footer/git.ts";
import { FooterContributionRegistry } from "./footer/registry.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  isCosmicFooterInvalidateEvent,
  isCosmicFooterRemoveEvent,
  isCosmicFooterUpsertEvent,
  isCosmicUiHostQuery,
} from "./protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";

const GIT_REFRESH_INTERVAL_MS = 2_000;

const EMPTY_TOTALS = (): FooterTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

function terminalUi(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui";
}

export default function cosmicUi(pi: ExtensionAPI): void {
  const registry = new FooterContributionRegistry();
  let config: ResolvedCosmicUiConfig | undefined;
  let totals = EMPTY_TOTALS();
  let installed = false;
  let installedContext: ExtensionContext | undefined;
  let footerComponent: ReturnType<typeof createFooterComponent> | undefined;
  let gitStatus: FooterGitStatus | undefined;
  let gitRefreshTimer: ReturnType<typeof setInterval> | undefined;

  const refreshTotals = (ctx: ExtensionContext) => {
    totals = EMPTY_TOTALS();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      totals.input += entry.message.usage.input;
      totals.output += entry.message.usage.output;
      totals.cacheRead += entry.message.usage.cacheRead;
      totals.cacheWrite += entry.message.usage.cacheWrite;
      totals.cost += entry.message.usage.cost.total;
    }
  };

  const refreshGitStatus = async (ctx: ExtensionContext) => {
    if (!terminalUi(ctx) || installedContext !== ctx) return;
    const cwd = ctx.sessionManager.getCwd();
    let nextStatus: FooterGitStatus | undefined;
    try {
      const result = await pi.exec(
        "git",
        ["status", "--short", "--branch", "--untracked-files=normal"],
        { cwd, timeout: 2_000 },
      );
      if (installedContext !== ctx) return;
      nextStatus = result.code === 0 ? parseGitStatus(result.stdout) : undefined;
    } catch {
      if (installedContext !== ctx) return;
      nextStatus = undefined;
    }
    if (nextStatus && nextStatus.staged + nextStatus.modified + nextStatus.conflicts > 0) {
      try {
        const diff = await pi.exec("git", ["diff", "--numstat", "HEAD", "--"], {
          cwd,
          timeout: 2_000,
        });
        if (installedContext !== ctx) return;
        if (diff.code === 0) nextStatus = applyGitNumstat(nextStatus, diff.stdout);
      } catch {
        // Keep file-level status when line statistics are unavailable.
      }
    }
    if (JSON.stringify(gitStatus) === JSON.stringify(nextStatus)) return;
    gitStatus = nextStatus;
    registry.requestRenderNow();
  };

  const stopGitPolling = () => {
    if (gitRefreshTimer) clearInterval(gitRefreshTimer);
    gitRefreshTimer = undefined;
  };

  const startGitPolling = (ctx: ExtensionContext) => {
    stopGitPolling();
    gitRefreshTimer = setInterval(() => void refreshGitStatus(ctx), GIT_REFRESH_INTERVAL_MS);
    gitRefreshTimer.unref();
  };

  const update = (ctx: ExtensionContext) => {
    const current = config ?? (config = resolveConfig(ctx.cwd));
    if (!terminalUi(ctx)) return;
    if (installed && installedContext !== ctx) {
      stopGitPolling();
      ctx.ui.setFooter(undefined);
      installed = false;
      installedContext = undefined;
      footerComponent = undefined;
      registry.setRenderRequest(undefined);
    }
    if (!current.footer.enabled) {
      stopGitPolling();
      if (installed) ctx.ui.setFooter(undefined);
      installed = false;
      installedContext = undefined;
      footerComponent = undefined;
      registry.setRenderRequest(undefined);
      return;
    }
    if (installed) {
      registry.requestRenderNow();
      return;
    }
    installed = true;
    installedContext = ctx;
    ctx.ui.setFooter((tui, theme, footerData) => {
      registry.setRenderRequest(() => tui.requestRender());
      const unsubscribeBranch = footerData.onBranchChange(() => {
        tui.requestRender();
        void refreshGitStatus(ctx);
      });
      const component = createFooterComponent({
        pi,
        ctx,
        footerData,
        theme,
        registry,
        config: () => config ?? resolveConfig(ctx.cwd),
        totals: () => totals,
        gitStatus: () => gitStatus,
      });
      footerComponent = component;
      return {
        ...component,
        dispose() {
          stopGitPolling();
          unsubscribeBranch();
          registry.setRenderRequest(undefined);
          installed = false;
          installedContext = undefined;
          footerComponent = undefined;
        },
      };
    });
    startGitPolling(ctx);
  };

  const unsubscribers = [
    pi.events.on(COSMIC_UI_HOST_QUERY, (data) => {
      if (isCosmicUiHostQuery(data)) data.respond();
    }),
    pi.events.on(COSMIC_UI_FOOTER_UPSERT, (data) => {
      if (isCosmicFooterUpsertEvent(data)) registry.upsert(data.owner, data.contribution);
    }),
    pi.events.on(COSMIC_UI_FOOTER_REMOVE, (data) => {
      if (isCosmicFooterRemoveEvent(data)) registry.remove(data.owner, data.id);
    }),
    pi.events.on(COSMIC_UI_FOOTER_INVALIDATE, (data) => {
      if (isCosmicFooterInvalidateEvent(data)) registry.invalidate(data.owner, data.id);
    }),
  ];

  registerSettingsCommand(pi, {
    config: () => config ?? resolveConfig(process.cwd()),
    setConfig: (next) => {
      config = next;
    },
    update,
  });

  pi.on("session_start", async (_event, ctx) => {
    config = resolveConfig(ctx.cwd);
    gitStatus = undefined;
    refreshTotals(ctx);
    update(ctx);
    await refreshGitStatus(ctx);
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event.message?.role === "assistant") {
      totals.input += event.message.usage.input;
      totals.output += event.message.usage.output;
      totals.cacheRead += event.message.usage.cacheRead;
      totals.cacheWrite += event.message.usage.cacheWrite;
      totals.cost += event.message.usage.cost.total;
    } else refreshTotals(ctx);
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
    await refreshGitStatus(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    refreshTotals(ctx);
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("session_tree", (_event, ctx) => {
    refreshTotals(ctx);
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("model_select", () => {
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    if (["bash", "edit", "write"].includes(event.toolName)) await refreshGitStatus(ctx);
  });
  pi.on("thinking_level_select", () => registry.requestRenderNow());
  pi.on("session_info_changed", () => registry.requestRenderNow());
  pi.on("agent_start", () => {
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("message_start", () => {
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("message_update", () => {
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("message_end", () => {
    footerComponent?.invalidateContextUsage();
    registry.requestRenderNow();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    stopGitPolling();
    if (installed && terminalUi(ctx)) ctx.ui.setFooter(undefined);
    installed = false;
    installedContext = undefined;
    footerComponent = undefined;
    registry.clear();
    config = undefined;
    totals = EMPTY_TOTALS();
    gitStatus = undefined;
    for (const unsubscribe of unsubscribers) unsubscribe();
  });
}
