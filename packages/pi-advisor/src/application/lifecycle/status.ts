import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  advisorStatusIsAnimatedAtHostBoundary,
  resolveAdvisorStatusEffortAtHostBoundary,
  setAdvisorStatusAtHostBoundary,
} from "../../boundary/host-status.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import { redactSensitiveText } from "../../domain/redaction.ts";
import type { AdvisorStatusServiceShape } from "../../status/service.ts";
import {
  STATUS_KEY,
  STATUS_SPINNER_DELAY_MS,
  STATUS_SPINNER_FRAMES,
  STATUS_SPINNER_INTERVAL_MS,
} from "../controller-types.ts";
import { setAdvisorSpinnerOwner, type AdvisorApplicationState } from "../state.ts";

export const makeLifecycleStatusControls = (options: {
  readonly statusService: AdvisorStatusServiceShape;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly isPaused: () => boolean;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
}) => {
  const { statusService, currentConfig, isPaused, updateApplicationState } = options;

  const stopStatusSpinner = (): void => {
    statusService.clear();
    updateApplicationState((state) => setAdvisorSpinnerOwner(state));
  };

  const setAdvisorStatus = (ctx: ExtensionContext, text?: string): void => {
    stopStatusSpinner();
    setAdvisorStatusAtHostBoundary(ctx, STATUS_KEY, text);
  };

  const renderReviewStatus = (ctx: ExtensionContext, frameIndex: number): void => {
    try {
      const renderConfig = currentConfig();
      const frame =
        STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length] ??
        STATUS_SPINNER_FRAMES[0];
      const effort = resolveAdvisorStatusEffortAtHostBoundary(
        ctx,
        renderConfig.provider,
        renderConfig.model,
        renderConfig.thinkingLevel,
      );
      if (!effort.ok) {
        stopStatusSpinner();
        return;
      }
      const rendered = setAdvisorStatusAtHostBoundary(
        ctx,
        STATUS_KEY,
        `${frame} ${redactSensitiveText(renderConfig.model ?? "advisor").slice(0, 256)}:${effort.value} advising…`,
      );
      if (!rendered) stopStatusSpinner();
    } catch {
      stopStatusSpinner();
    }
  };

  const startStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
    updateApplicationState((state) => setAdvisorSpinnerOwner(state, owner));
    statusService.start({
      owner,
      delayMs: STATUS_SPINNER_DELAY_MS,
      intervalMs: STATUS_SPINNER_INTERVAL_MS,
      animated: advisorStatusIsAnimatedAtHostBoundary(ctx),
      frameCount: STATUS_SPINNER_FRAMES.length,
      render: (frame) => {
        updateApplicationState((state) => ({
          ...state,
          spinner: { ...state.spinner, frame },
        }));
        renderReviewStatus(ctx, frame);
      },
    });
  };

  const settleStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
    if (!statusService.settle(owner)) return;
    updateApplicationState((state) => setAdvisorSpinnerOwner(state));
    setAdvisorStatusAtHostBoundary(ctx, STATUS_KEY, isPaused() ? "advisor: paused" : undefined);
  };

  return {
    stopStatusSpinner,
    setAdvisorStatus,
    startStatusSpinner,
    settleStatusSpinner,
  } as const;
};
