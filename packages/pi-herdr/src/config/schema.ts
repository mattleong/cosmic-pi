import * as Schema from "effect/Schema";
import { HERDR_AGENT_STATES } from "../herd/model.ts";

export const HERDR_CONFIG_VERSION = 1;
export const HERDR_CONFIG_BASENAME = "pi-herdr.json";
export const HERDR_STATE_VERSION = 1;
export const HERDR_STATE_BASENAME = "state.json";
export const HERDR_MANAGED_TAB_LABEL = "pi-herdr · Claude";

export interface HerdrConfig {
  readonly enabled: boolean;
  readonly session?: string | undefined;
  readonly pollIntervalMs: number;
  readonly showFooterStatus: boolean;
  readonly maxRetained: number;
}

export const DEFAULT_HERDR_CONFIG: HerdrConfig = {
  enabled: true,
  pollIntervalMs: 1_000,
  showFooterStatus: true,
  maxRetained: 100,
};

export const HerdrConfigFileSchema = Schema.Struct({
  version: Schema.Literal(HERDR_CONFIG_VERSION),
  enabled: Schema.optional(Schema.Boolean),
  session: Schema.optional(Schema.String),
  pollIntervalMs: Schema.optional(Schema.Number),
  showFooterStatus: Schema.optional(Schema.Boolean),
  maxRetained: Schema.optional(Schema.Number),
});

export interface PersistedHerdrRun {
  readonly id: string;
  readonly name: string;
  readonly agentName: string;
  readonly task: string;
  readonly cwd: string;
  readonly state: (typeof HERDR_AGENT_STATES)[number];
  readonly remoteStatus?: "idle" | "working" | "blocked" | "done" | "unknown" | undefined;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId?: string | undefined;
  readonly reportGeneration: string;
  readonly report?: string | undefined;
  readonly error?: string | undefined;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number | undefined;
}

export interface PersistedHerdrProject {
  readonly key: string;
  readonly session: string;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly workspaceOwned: boolean;
  readonly tabId: string;
  readonly tabLabel: string;
  readonly anchorPaneId: string;
  readonly runs: ReadonlyArray<PersistedHerdrRun>;
}

const HerdrRunIdSchema = Schema.String.check(Schema.isPattern(/^herdr-[a-z0-9-]{1,80}$/));

const PersistedRunSchema = Schema.Struct({
  id: HerdrRunIdSchema,
  name: Schema.String,
  agentName: Schema.String,
  task: Schema.String,
  cwd: Schema.String,
  state: Schema.Literals(HERDR_AGENT_STATES),
  remoteStatus: Schema.optional(Schema.Literals(["idle", "working", "blocked", "done", "unknown"])),
  workspaceId: Schema.String,
  tabId: Schema.String,
  paneId: Schema.String,
  terminalId: Schema.optional(Schema.String),
  reportGeneration: HerdrRunIdSchema,
  report: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
});

export const PersistedProjectSchema = Schema.Struct({
  key: Schema.String,
  session: Schema.String,
  cwd: Schema.String,
  workspaceId: Schema.String,
  workspaceOwned: Schema.Boolean,
  tabId: Schema.String,
  tabLabel: Schema.String,
  anchorPaneId: Schema.String,
  runs: Schema.Array(PersistedRunSchema),
});

export const HerdrStateDocumentSchema = Schema.Struct({
  version: Schema.Literal(HERDR_STATE_VERSION),
  projects: Schema.Array(PersistedProjectSchema),
});

export interface HerdrStateDocument {
  readonly version: typeof HERDR_STATE_VERSION;
  readonly projects: ReadonlyArray<PersistedHerdrProject>;
}
