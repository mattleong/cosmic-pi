import type {
  ExtensionAPI,
  ToolRenderers,
  ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import { codePreviewSettings } from "../config/state";
import {
  capturePreviewHostTools,
  isBuiltinPreviewTool,
  isNativePreviewTool,
  isOwnedWritePreviewTool,
  rendererFields,
  type PreviewHostTools,
} from "../boundary/host-tool-renderers";
import { CORE_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../tools/names";
import { createBuiltinPreviewRenderers } from "../tools/renderers/registration";
import { createNativeCodemodeRenderers } from "../tools/native-codemode-render";
import {
  resetCodePreviewToolStatuses,
  setCodePreviewToolStatus,
  setNativeMcpRendererAvailable,
} from "../tools/status";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { CodePreviewSchedulerServiceContract } from "./scheduler";
import type { CodePreviewRendererSession } from "./renderer-contract";
import { selectNativeMcpRenderers } from "./native-mcp-renderers";
import { retainedCodePreviewRenderers, type RetainedRendererOwner } from "./renderer-row";

const isCore = (name: string): name is (typeof CORE_CODE_PREVIEW_TOOLS)[number] =>
  CORE_CODE_PREVIEW_TOOLS.some((tool) => tool === name);
const isMcp = (name: string) =>
  name.startsWith("mcp__") ||
  ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(name);

/** An origin token: readiness can change once, but ownership never follows the global slot. */
export class CodePreviewPresentationOwner implements RetainedRendererOwner {
  live = true;
  ready = false;
  session: CodePreviewRendererSession | undefined;
  enabled: ReadonlySet<CodePreviewToolName> = new Set();
  private readonly refreshers = new Set<() => void>();
  private readonly cancellations = new Set<() => void>();

  subscribe(refresh: () => void): void {
    if (this.live && !this.ready) this.refreshers.add(refresh);
  }

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
    this.enabled = new Set(enabled);
    this.scheduler = scheduler;
    this.session = Object.freeze({
      cwd,
      selfShell: true,
      scheduleAnimation: this.scheduleAnimation,
      mode: codePreviewSettings.toolCallBackground,
      collapsedStyle: codePreviewSettings.toolCallCollapsedStyle,
      enabledTools: Object.freeze([...enabled]),
    });
    this.ready = true;
    for (const refresh of this.refreshers) invokeHostCallback(refresh, undefined);
    this.refreshers.clear();
  }

  retire(): void {
    this.live = false;
    this.scheduler = undefined;
    // Revoke authority and cancel subscriptions synchronously, before Effect scope disposal.
    for (const cancel of this.cancellations) invokeHostCallback(cancel, undefined);
    this.refreshers.clear();
  }
}

function candidate(
  name: string,
  host: PreviewHostTools,
  ownedTools: ReadonlySet<CodePreviewToolName>,
): boolean {
  const tool = host.tools.get(name);
  if (isCore(name))
    return (
      isBuiltinPreviewTool(tool) ||
      (name === "write" &&
        ownedTools.has("write") &&
        isOwnedWritePreviewTool(tool, host.previewSource))
    );
  if (name === "codemode") return isNativePreviewTool(tool, "codemode");
  return isMcp(name) && (tool ? isNativePreviewTool(tool, "mcp") : host.nativeManager);
}

function select(
  name: string,
  downstream: ToolRenderers | undefined,
  owner: CodePreviewPresentationOwner,
  host: PreviewHostTools,
  ownedTools: ReadonlySet<CodePreviewToolName>,
): ToolRenderers | undefined {
  const session = owner.session;
  if (!session || !candidate(name, host, ownedTools)) return undefined;
  if (isCore(name))
    return owner.enabled.has(name) ? createBuiltinPreviewRenderers(name, session) : undefined;
  if (name === "codemode")
    return owner.enabled.has("codemode")
      ? createNativeCodemodeRenderers(session.cwd, session.scheduleAnimation, true, session)
      : undefined;
  return selectNativeMcpRenderers(
    name,
    host.tools.get(name),
    host.nativeManager,
    downstream,
    session,
  );
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
    if (!owner.live) return downstream;
    const host = invokeHostCallback(() => capturePreviewHostTools(pi), undefined);
    // Prebind discovery may be empty or unavailable. A raw self facade claims no native identity;
    // semantic source admission is deferred until the originating session becomes ready.
    const deferredAdmission =
      !owner.ready && (isCore(name) || name === "codemode") && (!host || !host.tools.has(name));
    if (!deferredAdmission && (!host || !candidate(name, host, ownedTools))) return downstream;
    // Ready resolutions freeze settings immediately. Cold replay freezes at first readiness.
    let selected =
      owner.ready && host
        ? invokeHostCallback(() => select(name, downstream, owner, host, ownedTools), undefined)
        : undefined;
    if (owner.ready && !selected) return downstream;
    return retainedCodePreviewRenderers(name, downstream, owner, () => {
      selected ??= invokeHostCallback(
        () => select(name, downstream, owner, capturePreviewHostTools(pi), ownedTools),
        undefined,
      );
      return selected;
    });
  };
}

export function publishPreviewToolStatuses(
  host: PreviewHostTools,
  enabled: Set<CodePreviewToolName>,
  ownedTools: ReadonlySet<CodePreviewToolName>,
): void {
  resetCodePreviewToolStatuses(enabled);
  for (const name of [...CORE_CODE_PREVIEW_TOOLS, "codemode"] as const) {
    if (!enabled.has(name)) continue;
    const tool = host.tools.get(name);
    if (!tool) setCodePreviewToolStatus(name, { state: "unavailable" });
    else if (!candidate(name, host, ownedTools))
      setCodePreviewToolStatus(name, { state: "skipped-conflict", owner: tool.sourceInfo });
    else setCodePreviewToolStatus(name, { state: "installed" });
  }
  setNativeMcpRendererAvailable(
    host.nativeManager || [...host.tools.values()].some((tool) => isNativePreviewTool(tool, "mcp")),
  );
}
