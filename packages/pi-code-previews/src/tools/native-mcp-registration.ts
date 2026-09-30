import type { ExtensionAPI, ExtensionFactory, SourceInfo } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary } from "pi-cosmic-core";
import {
  composeNativeMcp,
  nativeMcpFactory,
  type NativeMcpDefinition,
  type NativeMcpGate,
} from "../boundary/host-native-mcp";
import type { CompactAnimationScheduler } from "./compact-summary";
import { styleNativeMcp } from "./native-mcp-render";

/**
 * Bounded plain status for health: `off` (opt-in disabled), `unavailable` (no public factory),
 * `failed` (composition registered nothing, so Pi keeps its builtin), `composed` (awaiting a
 * session), `owned` (this extension runs the one manager), or `conflict` (another `/mcp`).
 */
export type NativeMcpState = "off" | "unavailable" | "failed" | "composed" | "owned" | "conflict";
export interface NativeMcpStatus {
  readonly state: NativeMcpState;
  /** A presentation failure never disables MCP; affected definitions register unstyled. */
  readonly presentationFailed: boolean;
}

let status: NativeMcpStatus = { state: "off", presentationFailed: false };

export function getNativeMcpStatus(): NativeMcpStatus {
  return status;
}

/** Test seams only: production uses Pi's public factory with default options. */
export interface NativeMcpSeams {
  readonly createFactory: () => ExtensionFactory | undefined;
  readonly style: typeof styleNativeMcp;
}

/** One session's renderer authority; `live` turns false when that session retires. */
export interface NativeMcpPresentation {
  readonly presentation: { readonly live: boolean };
  readonly schedule: (interval: number, task: () => void) => () => void;
}

const productionSeams: NativeMcpSeams = { createFactory: nativeMcpFactory, style: styleNativeMcp };
const MANAGER = /^mcp(?::\d+)?$/u;
const ANCHOR = /^code-previews(?::\d+)?$/u;

const sameSource = (left: SourceInfo, right: SourceInfo): boolean =>
  left.source === right.source &&
  left.path === right.path &&
  left.scope === right.scope &&
  left.origin === right.origin;

/**
 * Public ownership evidence: exactly one extension `/mcp` (no `mcp:N` duplicates) whose source is
 * the unique, non-builtin `/code-previews` anchor. Any host failure fails closed.
 */
function ownsManager(pi: ExtensionAPI): boolean {
  try {
    const commands = pi.getCommands().filter((command) => command.source === "extension");
    const anchors = commands.filter((command) => ANCHOR.test(command.name));
    const managers = commands.filter((command) => MANAGER.test(command.name));
    const [anchor] = anchors;
    const [manager] = managers;
    return (
      anchors.length === 1 &&
      managers.length === 1 &&
      anchor?.name === "code-previews" &&
      manager?.name === "mcp" &&
      anchor.sourceInfo.source !== "builtin" &&
      sameSource(anchor.sourceInfo, manager.sourceInfo)
    );
  } catch {
    return false;
  }
}

/**
 * Owns one loaded extension's composition of Pi's native MCP manager. The manager starts only
 * when public evidence proves this extension owns the sole `/mcp`. Once admitted, native events
 * keep processing server removals and exposure changes; commands recheck ownership. Shutdown
 * of a started manager always runs.
 */
export function nativeMcpRegistration(seams: NativeMcpSeams = productionSeams) {
  let composed = false;
  let started = false;
  /** Admitted native starts; each shutdown handler runs once per started session. */
  let starts = 0;
  let current: NativeMcpPresentation | undefined;
  const setStatus = (state: NativeMcpState) => {
    status = { state, presentationFailed: status.presentationFailed };
  };

  const decorate = (definition: NativeMcpDefinition): NativeMcpDefinition => {
    const active = current;
    if (!active?.presentation.live) return definition;
    const { presentation, schedule } = active;
    const scheduleAnimation: CompactAnimationScheduler = (interval, tick) =>
      presentation.live
        ? schedule(interval, () => {
            if (presentation.live) tick();
          })
        : undefined;
    try {
      return seams.style(definition, scheduleAnimation);
    } catch {
      status = { ...status, presentationFailed: true };
      return definition;
    }
  };

  const gate = (pi: ExtensionAPI): NativeMcpGate => {
    const live = () => started && ownsManager(pi);
    return {
      event: (name, handler) => {
        let stopped = starts;
        return (event, ctx) => {
          if (name === "session_shutdown") {
            // No ownership check: a started manager must always release its connections.
            started = false;
            if (stopped === starts) return undefined;
            stopped = starts;
            return handler(event, ctx);
          }
          if (name !== "session_start") return started ? handler(event, ctx) : undefined;
          if (!composed) return undefined;
          if (!ownsManager(pi)) {
            setStatus("conflict");
            return undefined;
          }
          started = true;
          starts++;
          setStatus("owned");
          return handler(event, ctx);
        };
      },
      command: (command) => ({
        ...command,
        getArgumentCompletions: (prefix) =>
          live() ? (command.getArgumentCompletions?.(prefix) ?? null) : null,
        handler: (args, ctx) => {
          if (live()) return command.handler(args, ctx);
          notifyAtHostBoundary(
            ctx,
            "MCP manager ownership is ambiguous in this session",
            "warning",
          );
          return Promise.resolve();
        },
      }),
      tool: decorate,
    };
  };

  return {
    /** The startup opt-in is off: leave Pi's builtin untouched. */
    disable(): void {
      status = { state: "off", presentationFailed: false };
    },

    /** Factory-time composition after the main command and lifecycle handlers. Never rejects. */
    compose(pi: ExtensionAPI): Promise<void> {
      status = { state: "failed", presentationFailed: false };
      let factory: ExtensionFactory | undefined;
      try {
        factory = seams.createFactory();
      } catch {
        return Promise.resolve();
      }
      if (!factory) {
        setStatus("unavailable");
        return Promise.resolve();
      }
      return composeNativeMcp(pi, factory, gate(pi))
        .catch(() => false)
        .then((success) => {
          composed = success;
          setStatus(success ? "composed" : "failed");
        });
    },

    /** Publishes the activated session's scheduler for later callback-time decoration. */
    present(presentation: NativeMcpPresentation): void {
      current = presentation;
    },
  };
}
