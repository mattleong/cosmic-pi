import * as Effect from "effect/Effect";
import type { HerdrClientShape } from "../boundary/herdr-client.ts";
import { HERDR_MANAGED_TAB_LABEL, type PersistedHerdrProject } from "../config/schema.ts";
import type { HerdrSnapshot } from "./model.ts";
import { selectWorkspace } from "./coordination.ts";

export interface ManagedHerdrProject {
  readonly workspaceId: string;
  readonly workspaceOwned: boolean;
  readonly tabId: string;
  readonly anchorPaneId: string;
}

export const persistedProjectIsLive = (
  persisted: PersistedHerdrProject | undefined,
  snapshot: HerdrSnapshot,
): persisted is PersistedHerdrProject =>
  persisted !== undefined &&
  snapshot.workspaces.some((workspace) => workspace.workspaceId === persisted.workspaceId) &&
  snapshot.tabs.some(
    (tab) =>
      tab.tabId === persisted.tabId &&
      tab.workspaceId === persisted.workspaceId &&
      tab.label === persisted.tabLabel,
  ) &&
  snapshot.panes.some(
    (pane) =>
      pane.paneId === persisted.anchorPaneId &&
      pane.tabId === persisted.tabId &&
      pane.workspaceId === persisted.workspaceId,
  );

export const acquireManagedProject = Effect.fn("HerdrWorkspace.acquire")(function* (input: {
  readonly client: HerdrClientShape;
  readonly cwd: string;
  readonly workspaceLabel: string;
  readonly snapshot: HerdrSnapshot;
  readonly persisted?: PersistedHerdrProject | undefined;
}) {
  if (persistedProjectIsLive(input.persisted, input.snapshot))
    return {
      workspaceId: input.persisted.workspaceId,
      workspaceOwned: input.persisted.workspaceOwned,
      tabId: input.persisted.tabId,
      anchorPaneId: input.persisted.anchorPaneId,
    } satisfies ManagedHerdrProject;

  const selected = selectWorkspace(input.snapshot, input.cwd);
  if (selected) {
    const created = yield* input.client.createTab(
      selected.workspaceId,
      input.cwd,
      HERDR_MANAGED_TAB_LABEL,
    );
    return {
      workspaceId: selected.workspaceId,
      workspaceOwned: false,
      tabId: created.tab.tabId,
      anchorPaneId: created.rootPane.paneId,
    } satisfies ManagedHerdrProject;
  }

  const created = yield* input.client.createWorkspace(input.cwd, input.workspaceLabel);
  yield* input.client.renameTab(created.tab.tabId, HERDR_MANAGED_TAB_LABEL);
  return {
    workspaceId: created.workspace.workspaceId,
    workspaceOwned: true,
    tabId: created.tab.tabId,
    anchorPaneId: created.rootPane.paneId,
  } satisfies ManagedHerdrProject;
});
