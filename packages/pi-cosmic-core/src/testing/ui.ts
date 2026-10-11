import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { ignore, overlay, unavailable } from "./overlay.ts";
import { plainTheme } from "./theme.ts";

export const extensionUiFixture = (
  overrides: Partial<ExtensionUIContext> = {},
): ExtensionUIContext =>
  overlay<ExtensionUIContext>(
    {
      select: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      input: () => Promise.resolve(undefined),
      notify: ignore,
      onTerminalInput: () => ignore,
      setStatus: ignore,
      setWorkingMessage: ignore,
      setWorkingVisible: ignore,
      setWorkingIndicator: ignore,
      setHiddenThinkingLabel: ignore,
      setWidget: ignore,
      setFooter: ignore,
      setHeader: ignore,
      setTitle: ignore,
      custom: () => Promise.reject(unavailable("Custom UI")),
      pasteToEditor: ignore,
      setEditorText: ignore,
      getEditorText: () => "",
      editor: () => Promise.resolve(undefined),
      addAutocompleteProvider: ignore,
      setEditorComponent: ignore,
      getEditorComponent: () => undefined,
      theme: plainTheme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Themes are unavailable in this fixture." }),
      getToolsExpanded: () => false,
      setToolsExpanded: ignore,
    },
    overrides,
  );
