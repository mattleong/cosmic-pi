import type {
  ExtensionAPI,
  SourceInfo,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { captureFreshNativeCodemode } from "../boundary/host-native-codemode";
import type { CompactAnimationScheduler } from "./compact-summary";
import { styleNativeCodemode } from "./native-codemode-render";
import { setCodePreviewToolStatus } from "./status";

const isBuiltin = (source: SourceInfo): boolean =>
  source.source === "builtin" && source.path === "builtin:codemode";

const sameSource = (left: SourceInfo, right: SourceInfo): boolean =>
  left.source === right.source &&
  left.path === right.path &&
  left.scope === right.scope &&
  left.origin === right.origin;

interface OwnedNative {
  readonly source: SourceInfo;
  readonly parameters: ToolDefinition["parameters"];
}

export interface NativeCodemodeSnapshot {
  readonly visible: ToolInfo | undefined;
  readonly active: boolean;
  readonly owned: boolean;
  readonly ownerSource: SourceInfo | undefined;
}

/** One loaded lifecycle owns its registrations, but never retains a renderer capability. */
export function nativeCodemodeRegistration() {
  let owner: OwnedNative | undefined;
  const isOwned = (visible: ToolInfo | undefined): boolean =>
    !!visible &&
    !!owner &&
    visible.sourceInfo.source !== "builtin" &&
    sameSource(visible.sourceInfo, owner.source) &&
    visible.parameters === owner.parameters;

  return {
    /** Synchronous admission, before settings I/O or any other startup await. */
    capture(pi: ExtensionAPI): NativeCodemodeSnapshot {
      const visible = pi.getAllTools().find((tool) => tool.name === "codemode");
      const anchors = pi
        .getCommands()
        .filter((command) => command.name === "code-previews" && command.source === "extension");
      const anchor = anchors.length === 1 ? anchors[0]?.sourceInfo : undefined;
      const ownerSource = anchor && anchor.source !== "builtin" ? { ...anchor } : undefined;
      return {
        // Detach source metadata so later registry changes cannot rewrite admission evidence.
        visible: visible && { ...visible, sourceInfo: { ...visible.sourceInfo } },
        active: pi.getActiveTools().includes("codemode"),
        owned:
          isOwned(visible) && !!ownerSource && !!owner && sameSource(ownerSource, owner.source),
        ownerSource,
      };
    },

    register(
      pi: ExtensionAPI,
      snapshot: NativeCodemodeSnapshot,
      enabled: boolean,
      scheduleAnimation: CompactAnimationScheduler,
      cwd: string,
    ): void {
      const eligible =
        snapshot.owned ||
        (snapshot.active && !!snapshot.visible && isBuiltin(snapshot.visible.sourceInfo));
      if (!eligible) {
        if (!enabled) return;
        setCodePreviewToolStatus(
          "codemode",
          !snapshot.visible
            ? { state: "unavailable" }
            : !isBuiltin(snapshot.visible.sourceInfo)
              ? { state: "skipped-conflict", owner: snapshot.visible.sourceInfo }
              : { state: "not-active" },
        );
        return;
      }
      // Disabling presentation restores only a genuinely owned definition, never the builtin.
      if (!enabled && !snapshot.owned) return;
      if (!snapshot.ownerSource) {
        setCodePreviewToolStatus("codemode", { state: "unavailable" });
        return;
      }
      try {
        const anchors = pi
          .getCommands()
          .filter((command) => command.name === "code-previews" && command.source === "extension");
        if (
          anchors.length !== 1 ||
          !anchors[0] ||
          !sameSource(anchors[0].sourceInfo, snapshot.ownerSource)
        ) {
          setCodePreviewToolStatus("codemode", { state: "unavailable" });
          return;
        }
        const current = pi.getAllTools().find((tool) => tool.name === "codemode");
        if (
          !current ||
          !snapshot.visible ||
          !sameSource(current.sourceInfo, snapshot.visible.sourceInfo) ||
          current.parameters !== snapshot.visible.parameters ||
          (snapshot.owned ? !isOwned(current) : !isBuiltin(current.sourceInfo))
        ) {
          setCodePreviewToolStatus(
            "codemode",
            current
              ? { state: "skipped-conflict", owner: current.sourceInfo }
              : { state: "unavailable" },
          );
          return;
        }
        const fresh = captureFreshNativeCodemode(pi);
        if (!fresh) {
          setCodePreviewToolStatus("codemode", { state: "unavailable" });
          return;
        }
        const styled = enabled && snapshot.active;
        const definition = styled ? styleNativeCodemode(fresh, scheduleAnimation, cwd) : fresh;
        let failed = false;
        try {
          pi.registerTool(definition);
        } catch {
          // Pi can mutate its registry before refresh throws. Inspect public visible evidence,
          // but never force-register to displace whichever owner is actually visible.
          failed = true;
        }
        const visible = pi.getAllTools().find((tool) => tool.name === "codemode");
        if (!visible) {
          setCodePreviewToolStatus("codemode", { state: "registration-error" });
          return;
        }
        if (
          !sameSource(visible.sourceInfo, snapshot.ownerSource) ||
          visible.parameters !== fresh.parameters
        ) {
          setCodePreviewToolStatus("codemode", {
            state: "skipped-conflict",
            owner: visible.sourceInfo,
          });
          return;
        }
        owner = { source: { ...visible.sourceInfo }, parameters: fresh.parameters };
        setCodePreviewToolStatus(
          "codemode",
          failed
            ? { state: "registration-error" }
            : !enabled
              ? { state: "disabled-by-config" }
              : styled
                ? { state: "installed" }
                : { state: "not-active" },
        );
      } catch {
        setCodePreviewToolStatus("codemode", { state: "registration-error" });
      }
    },
  };
}
