/**
 * Better OpenAI for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the package-controlled allow-list.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  configPaths,
  type ResolvedConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "./config.ts";
import { FastController, supportsFast } from "./fast-controller.ts";
import { FAST_SERVICE_TIER, SUPPORTED_FAST_MODELS } from "./fast-models.ts";
import { createFooterController, type FooterController } from "./footer/controller.ts";
import { abbreviateHomePath } from "./footer-layout.ts";
import { registerOpenAIImage, _imageTest } from "./image.ts";
import { CONFIG_BASENAME } from "./identity.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { textPanel } from "./settings/picker.ts";
import { createCosmicUiAdapter, type CosmicUiAdapter } from "./ui/cosmic-adapter.ts";
import { UsageController } from "./usage-controller.ts";
import { formatPercent, formatUsageSnapshot, parseUsageSnapshot, readCodexAuth } from "./usage.ts";

const COMMAND = "fast";
const OPENAI_STATUS_COMMAND = "openai-usage";
const FLAG = "fast";
const SERVICE_TIER = FAST_SERVICE_TIER;

function hasTerminalUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

export default function betterOpenAI(pi: ExtensionAPI): void {
  const fastController = new FastController(SERVICE_TIER);
  let cachedConfig: ResolvedConfig | undefined;
  let footerController: FooterController;
  let cosmicUiAdapter: CosmicUiAdapter;

  function updateFooter(ctx: ExtensionContext): void {
    if (cosmicUiAdapter?.active) cosmicUiAdapter.update(ctx, config(ctx));
    else footerController.update(ctx);
  }

  const usageController = new UsageController(config, updateFooter);
  footerController = createFooterController({
    pi,
    config,
    fastController,
    usageController,
    hasTerminalUI,
  });
  cosmicUiAdapter = createCosmicUiAdapter({ pi, fastController, usageController });
  const {
    invalidateContextUsage,
    invalidateSessionName,
    refreshTotals: refreshFooterTotals,
  } = footerController;

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function persist(nextConfig: ResolvedConfig): void {
    cachedConfig = {
      ...nextConfig,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    };
    if (!nextConfig.persistState) return;
    writeConfig(nextConfig.configPath, {
      ...readRawConfig(nextConfig.configPath),
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    });
  }

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const nextConfig = refresh(ctx);
    fastController.setDesired(ctx, next);
    persist(nextConfig);
    updateFooter(ctx);
    if (next && !fastController.active) {
      ctx.ui.notify(fastController.unsupportedRequestMessage(ctx), "warning");
      return;
    }
    ctx.ui.notify(fastController.stateText(ctx), "info");
  }

  pi.registerFlag(FLAG, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });

  function formatDebugStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    return [
      ...fastController.debugLines(ctx),
      `Footer mode: ${cfg.footer.mode}`,
      "",
      usageController.formatDebug(ctx),
      "",
      `Image enabled: ${cfg.image.enabled}`,
      `Image default save: ${cfg.image.defaultSave}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  }

  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return setActive(ctx, !fastController.desiredActive);
      ctx.ui.notify("Usage: /fast", "error");
    },
  });

  pi.registerCommand(OPENAI_STATUS_COMMAND, {
    description: "Show OpenAI subscription usage status",
    handler: async (_args, ctx) => {
      await usageController.refresh(ctx, ctx.model?.id, { notify: true, force: true });
    },
  });

  registerSettingsController(pi, {
    config,
    refresh,
    updateFooter,
    hasTerminalUI,
    formatDebugStatus,
    fastController,
    usageController,
  });

  registerOpenAIImage(pi, config);

  pi.on("session_start", (_event, ctx) => {
    invalidateContextUsage();
    invalidateSessionName();
    const nextConfig = refresh(ctx);
    fastController.initializeForSession(ctx, nextConfig, pi.getFlag(FLAG) === true);
    if (
      fastController.desiredActive !== nextConfig.desiredActive ||
      fastController.active !== nextConfig.active
    )
      persist(nextConfig);
    if (fastController.desiredActive && !fastController.active) {
      ctx.ui.notify(fastController.unsupportedRequestMessage(ctx), "warning");
    }
    if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
    else cosmicUiAdapter.shutdown();
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    usageController.start(ctx);
    if (fastController.active) ctx.ui.notify(fastController.stateText(ctx), "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    invalidateContextUsage();
    updateFooter(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    invalidateContextUsage();
    if (event.message?.role === "assistant") {
      footerController.addAssistantUsage(event.message.usage);
    } else refreshFooterTotals(ctx);
    updateFooter(ctx);
    void usageController.refresh(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    updateFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    updateFooter(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    invalidateContextUsage();
    const cfg = config(ctx);
    const wasActive = fastController.active;
    fastController.applyDesiredState(ctx);
    if (fastController.active !== wasActive) {
      persist(cfg);
      ctx.ui.notify(
        fastController.active
          ? fastController.stateText(ctx)
          : fastController.inactiveForModelMessage(ctx),
        fastController.active ? "info" : "warning",
      );
    }
    updateFooter(ctx);
    void usageController.refresh(ctx, event.model.id, { force: true });
  });

  pi.on("session_shutdown", () => {
    invalidateContextUsage();
    invalidateSessionName();
    cosmicUiAdapter.shutdown();
    usageController.shutdown();
  });

  pi.on("before_provider_request", (event, ctx) => {
    return fastController.injectProviderPayload(event, ctx);
  });

  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", invalidateContextUsage);
  pi.on("message_end", invalidateContextUsage);
}

export const _test = {
  CONFIG_BASENAME,
  SUPPORTED_FAST_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  SERVICE_TIER,
  configPaths,
  abbreviateHomePath,
  resolveConfig,
  readRawConfig,
  supportsFast,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  readCodexAuth,
  textPanel,
  imageTest: _imageTest,
};
