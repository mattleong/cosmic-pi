/** Thin Pi registration adapter for Ask User. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUserWithDependencies } from "./application.ts";

export function askUser(pi: ExtensionAPI): void {
  askUserWithDependencies(pi, {});
}
