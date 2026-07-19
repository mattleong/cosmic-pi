/**
 * Better xAI for pi.
 *
 * Shows SuperGrok / X Premium subscription usage windows in the footer,
 * matching Better OpenAI's usage presentation when Cosmic UI is present.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ResolvedConfig, resolveConfig } from "./config.ts";
import { createFooterController, type FooterController } from "./footer/controller.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { createCosmicUiAdapter, type CosmicUiAdapter } from "./ui/cosmic-adapter.ts";
import { UsageController } from "./usage-controller.ts";

const XAI_STATUS_COMMAND = "xai-usage";

function hasTerminalUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

export default function betterXai(pi: ExtensionAPI): void {
  let cachedConfig: ResolvedConfig | undefined;
  let footerController: FooterController;
  let cosmicUiAdapter: CosmicUiAdapter;

  function updateFooter(ctx: ExtensionContext): void {
    if (cosmicUiAdapter?.active) cosmicUiAdapter.update(ctx, config(ctx));
    else footerController.update(ctx);
  }

  const usageController = new UsageController(config, updateFooter);
  footerController = createFooterController({
    config,
    usageController,
    hasTerminalUI,
  });
  cosmicUiAdapter = createCosmicUiAdapter({ pi, usageController });

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function formatDebugStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    return [
      usageController.formatDebug(ctx),
      "",
      `Footer mode: ${cfg.footer.mode}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  }

  pi.registerCommand(XAI_STATUS_COMMAND, {
    description: "Show xAI subscription usage status",
    handler: async (_args, ctx) => {
      await usageController.refresh(ctx, { notify: true, force: true });
    },
  });

  registerSettingsController(pi, {
    config,
    refresh,
    updateFooter,
    formatDebugStatus,
    usageController,
  });

  pi.on("session_start", (_event, ctx) => {
    refresh(ctx);
    if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
    else cosmicUiAdapter.shutdown();
    updateFooter(ctx);
    usageController.start(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    updateFooter(ctx);
    void usageController.refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    updateFooter(ctx);
    void usageController.refresh(ctx, { force: true });
  });

  pi.on("session_shutdown", () => {
    cosmicUiAdapter.shutdown();
    usageController.shutdown();
  });
}
