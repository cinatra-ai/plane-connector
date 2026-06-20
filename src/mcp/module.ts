import "server-only";

import type { ExtensionMcpToolServer } from "@cinatra-ai/sdk-extensions";
import { z } from "zod";

import {
  planeStatusHandler,
  planeInstancesListHandler,
  planeProjectsListHandler,
} from "./handlers";

const EmptySchema = z.object({});

function jsonResult<T>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as unknown as Record<string, unknown>,
  };
}

/**
 * Plane provider MCP module. Registers provider-specific primitives parallel to
 * the twenty/wordpress/drupal patterns.
 */
export function registerPlaneConnectorPrimitives(server: ExtensionMcpToolServer): void {
  server.registerTool(
    "plane_status",
    {
      title: "plane_status",
      description:
        "Report Plane connector health (instance reachability + auth probe). Parallel to twenty_status / wordpress_status.",
      inputSchema: EmptySchema,
    },
    async () => jsonResult(await planeStatusHandler()),
  );

  server.registerTool(
    "plane_instances_list",
    {
      title: "plane_instances_list",
      description:
        "List configured Plane connector instances (base URL + workspace slug + chosen project id).",
      inputSchema: EmptySchema,
    },
    async () => jsonResult(await planeInstancesListHandler()),
  );

  server.registerTool(
    "plane_projects_list",
    {
      title: "plane_projects_list",
      description:
        "List the concrete projects in the configured Plane workspace (id + identifier + name) for the explicit setup-time project mapping.",
      inputSchema: EmptySchema,
    },
    async () => jsonResult(await planeProjectsListHandler()),
  );
}

export function createPlaneConnectorModule() {
  return {
    registerCapabilities: registerPlaneConnectorPrimitives,
  };
}
