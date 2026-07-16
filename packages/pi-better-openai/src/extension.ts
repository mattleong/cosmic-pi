/**
 * Better OpenAI for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the package-controlled allow-list.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_BASENAME } from "./identity.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  configPaths,
  type ResolvedConfig,
  isRecord,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "./config.ts";
import { formatPercent, formatUsageSnapshot, parseUsageSnapshot, readCodexAuth } from "./usage.ts";
import { registerOpenAIImage, _imageTest } from "./image.ts";
import {
  describeCodexPetSelectionIssue,
  findReadyCodexPet,
  listCodexPets,
  registerOpenAIPets,
  _petsTest,
} from "./pets.ts";
import { FastController, supportsFast } from "./fast-controller.ts";
import { FAST_SERVICE_TIER, SUPPORTED_FAST_MODELS } from "./fast-models.ts";
import { UsageController } from "./usage-controller.ts";
import { PetFooterController } from "./pet-footer-controller.ts";
import {
  PET_EMPTY_VALUE,
  formatPetSelectPrompt,
  petConfigPickerValue,
  petPickerDescription,
  petSlugFromPickerValue,
  readyPetPickerValues,
} from "./settings/items.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { textPanel } from "./settings/picker.ts";
import { combineInlinePetFooter, abbreviateHomePath } from "./footer-layout.ts";
import { createFooterController, type FooterController } from "./footer/controller.ts";

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
  function updateFooter(ctx: ExtensionContext): void {
    footerController.update(ctx);
  }
  const usageController = new UsageController(config, updateFooter);
  const petController = new PetFooterController(
    config,
    updateFooter,
    () => footerController?.installed ?? false,
  );
  footerController = createFooterController({
    pi,
    config,
    fastController,
    usageController,
    petController,
    hasTerminalUI,
  });
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

  function writePetConfig(ctx: ExtensionContext, patch: Record<string, unknown>): ResolvedConfig {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    const pets = isRecord(current.pets) ? current.pets : {};
    writeConfig(cfg.configPath, { ...current, pets: { ...pets, ...patch } });
    petController.invalidateLoadKey();
    return refresh(ctx);
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
      `Pet enabled: ${cfg.pets.enabled}`,
      `Pet slug: ${cfg.pets.slug || PET_EMPTY_VALUE}`,
      `Pet placement: ${cfg.pets.placement}`,
      `Pet failed tool state: ${cfg.pets.failedToolState}`,
      `Pet idle emotes: ${cfg.pets.idleEmotes} (${cfg.pets.idleEmoteIntervalMs}ms)`,
      `Pet loaded: ${petController.loadedPet?.pet.name ?? "none"}`,
      `Pet error: ${petController.error ?? "none"}`,
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
    petController,
  });

  registerOpenAIImage(pi, config);
  registerOpenAIPets(pi, {
    wake: async (ctx, slug) => {
      const pets = await listCodexPets();
      const requestedSlug = (slug ?? config(ctx).pets.slug) || undefined;
      const selectedPet = findReadyCodexPet(pets, requestedSlug);
      if (!selectedPet) {
        const issue = describeCodexPetSelectionIssue(pets, requestedSlug);
        ctx.ui.notify(issue.message, "warning");
        return;
      }

      const next = writePetConfig(ctx, {
        enabled: true,
        slug: selectedPet.slug,
      });
      updateFooter(ctx);
      if (hasTerminalUI(ctx)) await petController.refresh(ctx, next, true);
      else
        ctx.ui.notify(
          `Enabled ${selectedPet.name} (${selectedPet.slug}); footer pets render in interactive TUI mode.`,
          "info",
        );
    },
    tuck: (ctx) => {
      writePetConfig(ctx, { enabled: false });
      petController.tuck();
      updateFooter(ctx);
      ctx.ui.notify("Footer pet tucked away.", "info");
    },
    select: async (ctx, slug) => {
      const pets = await listCodexPets();
      if (!slug) {
        const prompt = formatPetSelectPrompt(pets);
        ctx.ui.notify(prompt.message, prompt.level);
        return;
      }

      const selectedPet = findReadyCodexPet(pets, slug);
      if (!selectedPet) {
        const issue = describeCodexPetSelectionIssue(pets, slug);
        ctx.ui.notify(issue.message, "warning");
        return;
      }

      const next = writePetConfig(ctx, { slug: selectedPet.slug });
      updateFooter(ctx);
      if (petController.shouldLoadForConfig(next)) {
        if (hasTerminalUI(ctx)) await petController.refresh(ctx, next, true);
        else
          ctx.ui.notify(
            `Selected ${selectedPet.name} (${selectedPet.slug}); footer pets render in interactive TUI mode.`,
            "info",
          );
      } else {
        ctx.ui.notify(
          `Selected ${selectedPet.name} (${selectedPet.slug}) for the footer pet. Use /pets wake to show it.`,
          "info",
        );
      }
    },
  });

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
    if (hasTerminalUI(ctx)) petController.installResizeGuard(ctx);
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    if (hasTerminalUI(ctx) && nextConfig.pets.enabled) void petController.refresh(ctx, nextConfig);
    usageController.start(ctx);
    if (fastController.active) ctx.ui.notify(fastController.stateText(ctx), "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    invalidateContextUsage();
    petController.agentStart(ctx);
    updateFooter(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    petController.toolStart(ctx, event.toolCallId);
    updateFooter(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    petController.toolEnd(ctx, event.toolCallId, event.isError);
    if (!event.isError) updateFooter(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    petController.agentEnd();
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
    petController.queueKittyCleanup();
    petController.resetRenderCache();
    updateFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    invalidateContextUsage();
    refreshFooterTotals(ctx);
    petController.queueKittyCleanup();
    petController.resetRenderCache();
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
    usageController.shutdown();
    petController.shutdown();
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
  DEFAULT_PET_CONFIG,
  SERVICE_TIER,
  configPaths,
  abbreviateHomePath,
  resolveConfig,
  readRawConfig,
  supportsFast,
  combineInlinePetFooter,
  PET_EMPTY_VALUE,
  readyPetPickerValues,
  petConfigPickerValue,
  petSlugFromPickerValue,
  petPickerDescription,
  formatPetSelectPrompt,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  readCodexAuth,
  textPanel,
  imageTest: _imageTest,
  petsTest: _petsTest,
};
