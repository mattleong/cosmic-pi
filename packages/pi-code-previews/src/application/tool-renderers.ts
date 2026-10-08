import type {
  ExtensionAPI,
  ToolRenderers,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import { codePreviewSettings } from "../config/state";
import { capturePreviewHostTools, type PreviewHostTools } from "../boundary/host-tool-renderers";
import {
  ALL_CODE_PREVIEW_TOOLS,
  isCodePreviewToolName,
  type CodePreviewToolName,
} from "../tools/names";
import {
  admitsPreviewSource,
  isBuiltinTool,
  isCorePreviewName,
  isPreviewName,
} from "../tools/preview-admission";
import { createBuiltinPreviewRenderers } from "../tools/renderers/registration";
import { createNativeCodemodeRenderers } from "../tools/native-codemode-render";
import { createNativeMcpRenderers } from "../tools/native-mcp-render";
import { createNativeToolSearchRenderers } from "../tools/native-tool-search-render";
import {
  resetCodePreviewToolStatuses,
  setCodePreviewToolStatus,
  setNativeMcpRendererAvailable,
} from "../tools/status";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { CodePreviewSchedulerServiceContract } from "./scheduler";
import type { CodePreviewRendererSession } from "./renderer-contract";
import { rendererFields, RetainedRendererGate, retainedCodePreviewRenderers } from "./renderer-row";
import { isThirdPartyPreviewName, thirdPartyAdapter } from "../third-party/registry";

/** An origin token: readiness can change once, but ownership never follows the global slot. */
export class CodePreviewPresentationOwner extends RetainedRendererGate {
  session: CodePreviewRendererSession | undefined;
  private readonly cancellations = new Set<() => void>();

  readonly scheduleAnimation: CompactAnimationScheduler = (interval, tick) => {
    const scheduler = this.scheduler;
    if (!this.live || !this.ready || !scheduler) return undefined;
    const stop = scheduler.schedule(interval, () => {
      if (this.live) tick();
    });
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      this.cancellations.delete(cancel);
      stop();
    };
    this.cancellations.add(cancel);
    return cancel;
  };
  private scheduler: CodePreviewSchedulerServiceContract | undefined;

  publish(
    cwd: string,
    enabled: ReadonlySet<CodePreviewToolName>,
    scheduler: CodePreviewSchedulerServiceContract,
  ): void {
    if (!this.live || this.ready) return;
    this.scheduler = scheduler;
    this.session = Object.freeze({
      cwd,
      scheduleAnimation: this.scheduleAnimation,
      mode: codePreviewSettings.toolCallBackground,
      collapsedStyle: codePreviewSettings.toolCallCollapsedStyle,
      enabledTools: Object.freeze([...enabled]),
    });
    this.markReady();
  }

  override retire(): void {
    super.retire();
    this.scheduler = undefined;
    // Revoke authority and cancel subscriptions synchronously, before Effect scope disposal.
    for (const cancel of this.cancellations) invokeHostCallback(cancel, undefined);
  }
}

/**
 * Source admission happens once, here. Declining leaves downstream untouched; no execution
 * definition or manager is registered for presentation.
 */
function select(
  name: string,
  downstream: ToolRenderers | undefined,
  session: CodePreviewRendererSession,
  host: PreviewHostTools,
  ownedTools: ReadonlySet<CodePreviewToolName>,
  selfShell: boolean,
): ToolRenderers | undefined {
  const presentation = { ...session, selfShell };
  const external = thirdPartyAdapter(name, host.tools.get(name));
  if (external) return external.create(name, downstream, presentation);
  if (!admitsPreviewSource(name, host, ownedTools)) return undefined;
  if (isCorePreviewName(name)) return createBuiltinPreviewRenderers(name, presentation);
  if (name === "codemode")
    return session.enabledTools.includes("codemode")
      ? createNativeCodemodeRenderers(session.cwd, presentation)
      : undefined;
  if (name === "tool_search")
    return session.enabledTools.includes("tool_search")
      ? createNativeToolSearchRenderers(presentation)
      : undefined;
  // Every remaining admitted name is a native MCP tool or resource.
  return createNativeMcpRenderers(name, host.tools.get(name), downstream, presentation);
}

/** One resolver registration per extension factory, not per session. */
export function createCodePreviewRendererResolver(
  pi: ExtensionAPI,
  currentOwner: () => CodePreviewPresentationOwner,
  ownedTools: ReadonlySet<CodePreviewToolName>,
): ToolRendererResolver {
  return (name, next) => {
    const downstream = rendererFields(next());
    const owner = currentOwner();
    if (!owner.live || (!isPreviewName(name) && !isThirdPartyPreviewName(name))) return downstream;
    const selected = (selfShell: boolean) =>
      invokeHostCallback(
        () =>
          owner.session &&
          select(
            name,
            downstream,
            owner.session,
            capturePreviewHostTools(pi),
            ownedTools,
            selfShell,
          ),
        undefined,
      );
    // Rows resolved after readiness are ordinary renderers in Pi's own shell, frozen now.
    if (owner.ready && owner.session) return selected(false) ?? downstream;
    const host = invokeHostCallback(() => capturePreviewHostTools(pi), undefined);
    // Prebind discovery may be empty or unavailable. A raw self facade claims no native identity;
    // semantic source admission is deferred until the originating session becomes ready.
    const deferredAdmission = isCodePreviewToolName(name) && !host?.tools.has(name);
    if (
      !deferredAdmission &&
      (!host ||
        (!admitsPreviewSource(name, host, ownedTools) &&
          !thirdPartyAdapter(name, host.tools.get(name))))
    )
      return downstream;
    // Pi fixes a row's shell when it is built, so cold replay keeps a self shell and adopts the
    // first-ready appearance.
    return retainedCodePreviewRenderers(name, downstream, owner, () => selected(true));
  };
}

export function publishPreviewToolStatuses(
  host: PreviewHostTools,
  enabled: Set<CodePreviewToolName>,
  ownedTools: ReadonlySet<CodePreviewToolName>,
): void {
  resetCodePreviewToolStatuses(enabled);
  for (const name of ALL_CODE_PREVIEW_TOOLS) {
    if (!enabled.has(name)) continue;
    const tool = host.tools.get(name);
    if (!tool) setCodePreviewToolStatus(name, { state: "unavailable" });
    else if (!admitsPreviewSource(name, host, ownedTools))
      setCodePreviewToolStatus(name, { state: "skipped-conflict", owner: tool.sourceInfo });
    else setCodePreviewToolStatus(name, { state: "installed" });
  }
  setNativeMcpRendererAvailable(
    host.nativeManager || [...host.tools.values()].some((tool) => isBuiltinTool(tool, "mcp")),
  );
}
