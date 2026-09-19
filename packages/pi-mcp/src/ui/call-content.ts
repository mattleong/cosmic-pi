import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mcpContentPreview } from "./content-preview.ts";

/** Descriptor-safe display copy only. Machine arguments remain unchanged. */
export const renderMcpCallContent = <Args>(args: Args, theme: Pick<Theme, "fg">) =>
  new Text(theme.fg("toolOutput", `Input\n${mcpContentPreview("input", args).raw}`), 0, 0);
