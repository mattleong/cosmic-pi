import * as Effect from "effect/Effect";
import { boundaryError } from "../client/errors.ts";
import type { McpOperation } from "../connection/model.ts";
import {
  McpPromptMetadataSchema,
  McpResourceMetadataSchema,
  McpTemplateMetadataSchema,
  McpToolMetadataSchema,
  type McpDiscoveryDiagnostic,
} from "./model.ts";
import { freezeMetadata, listMetadata, metadataBudget } from "./pagination.ts";
import { isToolAllowed } from "./policy.ts";

/** Prepare all families under one owner and budget; only the service may publish the revision. */
export const collectMetadata = (operation: McpOperation) =>
  Effect.gen(function* () {
    const budget = metadataBudget();
    const tools = operation.capabilities.tools
      ? yield* listMetadata(
          operation,
          "tools.list",
          "tools",
          McpToolMetadataSchema,
          (entry) => entry.name,
          budget,
        )
      : undefined;
    const resources = operation.capabilities.resources
      ? yield* listMetadata(
          operation,
          "resources.list",
          "resources",
          McpResourceMetadataSchema,
          (entry) => entry.uri,
          budget,
        )
      : undefined;
    const templates = operation.capabilities.resources
      ? yield* listMetadata(
          operation,
          "resources.templates",
          "resourceTemplates",
          McpTemplateMetadataSchema,
          (entry) => entry.uriTemplate,
          budget,
        )
      : undefined;
    const prompts = operation.capabilities.prompts
      ? yield* listMetadata(
          operation,
          "prompts.list",
          "prompts",
          McpPromptMetadataSchema,
          (entry) => entry.name,
          budget,
        )
      : undefined;
    const diagnostics: Array<McpDiscoveryDiagnostic> = [];
    for (const [family, listing] of [
      ["tools", tools],
      ["resources", resources],
      ["templates", templates],
      ["prompts", prompts],
    ] as const) {
      if (listing?.supported === false) diagnostics.push({ family, reason: listing.reason });
    }
    return yield* Effect.try({
      try: () =>
        freezeMetadata(
          structuredClone({
            tools: (tools?.entries ?? []).filter((entry) =>
              isToolAllowed(operation.server, entry.name),
            ),
            resources: resources?.entries ?? [],
            templates: templates?.entries ?? [],
            prompts: prompts?.entries ?? [],
            support: {
              tools: tools?.supported ?? false,
              resources: resources?.supported ?? false,
              templates: templates?.supported ?? false,
              prompts: prompts?.supported ?? false,
            },
            diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
          }),
        ),
      catch: () =>
        boundaryError("output-limit", "not-sent", "Unable to prepare MCP metadata snapshot."),
    });
  });
