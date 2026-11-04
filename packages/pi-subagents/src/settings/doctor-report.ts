import * as Arr from "effect/Array";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { hasCustomSurface, openCommandSurface } from "pi-cosmic-ui/boundary/host-surface";
import { SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
import { TextPanelComponent } from "pi-cosmic-ui/manager/panel";
import type { DoctorCheck } from "../application/doctor.ts";

const TITLE = "Subagents doctor";

const STATUS_GLYPHS = {
  ok: SUITE_STATUS_GLYPHS.succeeded,
  warning: SUITE_STATUS_GLYPHS.warning,
  failed: SUITE_STATUS_GLYPHS.failed,
} as const satisfies Record<DoctorCheck["status"], string>;

/** One `✓ Label: detail` row per check; the panel hangs wrapped detail beneath the label. */
export const doctorReportLines = (checks: ReadonlyArray<DoctorCheck>): ReadonlyArray<string> =>
  Arr.map(checks, (item) => `${STATUS_GLYPHS[item.status]} ${item.label}: ${item.detail}`);

/** Shows the report in a read-only panel, or as a notice where Pi has no custom surface. */
export const showDoctorReport = (
  ctx: ExtensionCommandContext,
  checks: ReadonlyArray<DoctorCheck>,
  isCurrent: () => boolean,
): Promise<void> => {
  const lines = doctorReportLines(checks);
  if (!hasCustomSurface(ctx)) {
    if (ctx.hasUI)
      notifyAtHostBoundary(
        ctx,
        Arr.join([TITLE, ...lines], "\n"),
        Arr.some(checks, (item) => item.status !== "ok") ? "warning" : "info",
      );
    return Promise.resolve();
  }
  return openCommandSurface(ctx, {
    placement: "overlay",
    isCurrent,
    create: ({ theme, finish, getHeight }) =>
      new TextPanelComponent({
        theme,
        title: TITLE,
        lines,
        done: () => finish(undefined),
        maxHeight: getHeight,
      }),
  });
};
