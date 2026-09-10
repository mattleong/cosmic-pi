import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpOperation } from "../connection/model.ts";
import type { McpDataRequest } from "../tools/model.ts";

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024));
const Description = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64 * 1024)));
const Metadata = {
  title: Schema.optionalKey(Name),
  description: Description,
  icons: Schema.optionalKey(Schema.Json),
  _meta: Schema.optionalKey(Schema.Json),
};
const Rest = [Schema.Record(Schema.String, Schema.Json)] as const;

/** Remote schemas and annotations are data, never compiled by discovery. */
export const McpToolMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Name,
    ...Metadata,
    inputSchema: Schema.Json,
    outputSchema: Schema.optionalKey(Schema.Json),
    annotations: Schema.optionalKey(Schema.Json),
  }),
  Rest,
);
export const McpResourceMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Name,
    uri: Name,
    ...Metadata,
    mimeType: Schema.optionalKey(Name),
    size: Schema.optionalKey(Schema.Natural),
    annotations: Schema.optionalKey(Schema.Json),
  }),
  Rest,
);
export const McpTemplateMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Name,
    uriTemplate: Name,
    ...Metadata,
    mimeType: Schema.optionalKey(Name),
    annotations: Schema.optionalKey(Schema.Json),
  }),
  Rest,
);
export const McpPromptMetadataSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Name,
    ...Metadata,
    arguments: Schema.optionalKey(
      Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({
            name: Name,
            description: Description,
            required: Schema.optionalKey(Schema.Boolean),
          }),
          Rest,
        ),
      ).check(Schema.isMaxLength(100)),
    ),
  }),
  Rest,
);

export type McpToolMetadata = typeof McpToolMetadataSchema.Type;
export type McpResourceMetadata = typeof McpResourceMetadataSchema.Type;
export type McpTemplateMetadata = typeof McpTemplateMetadataSchema.Type;
export type McpPromptMetadata = typeof McpPromptMetadataSchema.Type;
export interface McpMetadataSnapshot {
  readonly server: string;
  readonly identity: string;
  readonly owner: string;
  readonly configRevision: number;
  readonly revision: number;
  readonly tools: ReadonlyArray<McpToolMetadata>;
  readonly resources: ReadonlyArray<McpResourceMetadata>;
  readonly templates: ReadonlyArray<McpTemplateMetadata>;
  readonly prompts: ReadonlyArray<McpPromptMetadata>;
}
export interface McpMetadataSummary {
  readonly server: string;
  readonly revision: number;
  readonly tools: number;
  readonly resources: number;
  readonly templates: number;
  readonly prompts: number;
}
export type McpDiscoveryRequest = Extract<
  McpDataRequest,
  {
    readonly action:
      | "tools.list"
      | "tools.search"
      | "tools.describe"
      | "resources.list"
      | "resources.templates"
      | "prompts.list";
  }
>;
export interface McpDiscoveryContract {
  readonly ensure: (
    operation: McpOperation,
  ) => Effect.Effect<McpMetadataSnapshot, McpBoundaryError>;
  readonly refresh: (
    operation: McpOperation,
  ) => Effect.Effect<McpMetadataSnapshot, McpBoundaryError>;
  readonly query: (
    request: McpDiscoveryRequest,
    operation?: McpOperation,
  ) => Effect.Effect<Schema.Json, McpBoundaryError>;
  readonly known: Effect.Effect<ReadonlyArray<McpMetadataSummary>>;
}

export const MCP_DISCOVERY_LIMITS = Object.freeze({
  pages: 64,
  entriesPerFamily: 1_000,
  metadataBytes: 4 * 1024 * 1024,
  metadataNodes: 100_000,
  metadataDepth: 64,
  cursorBytes: 8_192,
  retainedCursors: 1_024,
  defaultPage: 20,
  maximumPage: 100,
});
