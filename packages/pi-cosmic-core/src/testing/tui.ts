import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { ignore, overlay } from "./overlay.ts";

type CustomComponentFactory = Parameters<ExtensionUIContext["custom"]>[0];
type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

export type HostTui = Parameters<CustomComponentFactory>[0];
export type HostTerminal = HostTui["terminal"];
export type HostComponent = Parameters<HostTui["addChild"]>[0];
export type HostOverlayHandle = ReturnType<HostTui["showOverlay"]>;
export type HostKeybindings = Pick<KeybindingsManager, keyof KeybindingsManager>;
export type HostFooterData = Parameters<FooterFactory>[2];

export const terminalFixture = (overrides: Partial<HostTerminal> = {}): HostTerminal =>
  overlay<HostTerminal>(
    {
      start: ignore,
      stop: ignore,
      drainInput: () => Promise.resolve(),
      write: ignore,
      columns: 80,
      rows: 24,
      kittyProtocolActive: false,
      moveBy: ignore,
      hideCursor: ignore,
      showCursor: ignore,
      clearLine: ignore,
      clearFromCursor: ignore,
      clearScreen: ignore,
      setTitle: ignore,
      setProgress: ignore,
      setProgramStatus: ignore,
    },
    overrides,
  );

export const overlayHandleFixture = (
  overrides: Partial<HostOverlayHandle> = {},
): HostOverlayHandle => {
  let hidden = false;
  let focused = false;
  return overlay<HostOverlayHandle>(
    {
      hide: () => {
        hidden = true;
      },
      setHidden: (next) => {
        hidden = next;
      },
      isHidden: () => hidden,
      focus: () => {
        focused = true;
      },
      unfocus: () => {
        focused = false;
      },
      isFocused: () => focused,
      getBounds: () => undefined,
    },
    overrides,
  );
};

export const tuiFixture = (overrides: Partial<HostTui> = {}): HostTui => {
  const children: Array<HostComponent> = [];
  return overlay<HostTui>(
    {
      mode: "regular",
      children,
      terminal: terminalFixture(),
      fullRedraws: 0,
      addChild: (component) => {
        children.push(component);
      },
      removeChild: (component) => {
        const index = children.indexOf(component);
        if (index >= 0) children.splice(index, 1);
      },
      clear: () => {
        children.splice(0);
      },
      getShowHardwareCursor: () => false,
      setShowHardwareCursor: ignore,
      getClearOnShrink: () => false,
      setClearOnShrink: ignore,
      setFocus: ignore,
      showOverlay: () => overlayHandleFixture(),
      hideOverlay: ignore,
      hasOverlay: () => false,
      start: ignore,
      stop: ignore,
      renderNow: ignore,
      requestRender: ignore,
      addInputListener: () => ignore,
      removeInputListener: ignore,
      onTerminalColorSchemeChange: () => ignore,
      setTerminalColorSchemeNotifications: ignore,
      queryTerminalColors: () => Promise.resolve({}),
      render: (width) => children.flatMap((child) => child.render(width)),
      invalidate: () => {
        for (const child of children) child.invalidate();
      },
    },
    overrides,
  );
};

export const keybindingsFixture = (overrides: Partial<HostKeybindings> = {}): HostKeybindings =>
  overlay<HostKeybindings>(
    {
      matches: () => false,
      getKeys: () => [],
      getDefinition: () => ({ defaultKeys: [] }),
      getConflicts: () => [],
      setUserBindings: ignore,
      getUserBindings: () => ({}),
      getResolvedBindings: () => ({}),
      reload: ignore,
      getEffectiveConfig: () => ({}),
    },
    overrides,
  );

export const footerDataFixture = (overrides: Partial<HostFooterData> = {}): HostFooterData =>
  overlay<HostFooterData>(
    {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: () => ignore,
    },
    overrides,
  );
