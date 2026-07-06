// Connector-owned dev-mode provisioning hook (cinatra-ai/cinatra#976, epic
// #978 wave W-D) — the Plane block relocated VERBATIM-in-behavior from the
// host's `src/lib/dev-auto-setup.ts` behind the `cinatra.devSetup` manifest
// hook.
//
// SMOKE-PROVEN facts (Plane CE 1.3.1, on-the-wire, cinatra#315/#320) that make
// Plane DIVERGE from the Twenty archetype — the row wiring below is
// deliberately NOT a Twenty copy:
//   - AUTH: `X-API-Key` is the SOLE REST authenticator (a custom header).
//     `Authorization: Bearer <pat>` -> 401. So the external_mcp_servers
//     Bearer/Nango resolution CANNOT carry Plane's auth; `nangoConnectionId`
//     is therefore null and no bearer is minted/attached here.
//   - TOOL SURFACE: Plane's official MCP (makeplane/plane-mcp-server) exposes
//     DIRECT-NAMED tools (`create_work_item`, ...) — there is NO `execute_tool`
//     dispatcher. So the host's Layer-B `execute_tool` catalog proxy is a no-op
//     for Plane; the LLM surface is constrained by Layer-A `allowedTools`
//     (literal tool names) with `allowedCatalogTools: null` — the INVERSE of
//     Twenty.
//   - MCP BRIDGE: Plane CE itself is NOT an MCP server; the FastMCP bridge is a
//     SEPARATE process and is NOT in the community compose. We therefore wire
//     an enabled row ONLY when a real bridge URL (PLANE_MCP_URL) answers
//     `tools/list` — never a misleading row pointing at a non-existent endpoint.
//   - PAT MINT: minted via the USER-level `POST /api/users/api-tokens/`, which
//     needs an authenticated session. Plane has NO headless CLI mint (unlike
//     Twenty's `workspace:generate-api-key`), so the dev setup does NOT
//     auto-mint; it logs a one-time sign-up + connect hint instead.
//
// Idempotent. Soft-fails (returns a status object) — never throws. Secret-safe:
// no credentials are sent or logged (only a static JSON-RPC envelope).
//
// SDK imports are TYPE-ONLY (host-peer value-import ban); the host services
// resolve at call time through the capability port on the hook context.

import type {
  ExtensionDevSetupContext,
  ExtensionDevSetupStatus,
  HostExternalMcpRegistryService,
} from "@cinatra-ai/sdk-extensions";

export const LOCAL_PLANE = {
  containerName: "cinatra-plane-proxy-1",
  // The single loopback-published port of the whole Plane stack (proxy -> api).
  serverUrl: "http://localhost:3400",
  // Liveness endpoint served by the api behind the proxy (answers pre-sign-up).
  healthPath: "/api/instances/",
  rowId: "plane-workspace",
  rowLabel: "Plane (local dev)",
  // Optional separate FastMCP bridge (makeplane/plane-mcp-server, HTTP+api-key).
  // Not part of the community compose — only wired when this URL answers.
  mcpUrlEnvVar: "PLANE_MCP_URL",
  // Layer-A native-tool allowlist (DIRECT tool names; `allowedCatalogTools`
  // stays null). Read + work-item write verbs the PM-sync port needs.
  allowedTools: [
    "list_projects",
    "list_work_items",
    "create_work_item",
    "retrieve_work_item",
    "update_work_item",
    "delete_work_item",
    "search_work_items",
  ] as string[],
} as const;

export type PlaneDevSetupDeps = {
  registry: Pick<HostExternalMcpRegistryService, "getServerById" | "upsertServer">;
  helpers: ExtensionDevSetupContext["helpers"];
  log: (message: string) => void;
};

/**
 * Probe a Plane MCP bridge URL by issuing a JSON-RPC `tools/list`. Returns the
 * advertised tool-name count on success, or null when the URL is unset /
 * unreachable / not an MCP server / not a PLANE MCP server. Bounded (4s) + soft
 * (never throws): a missing bridge is the COMMON case (the community compose
 * ships no MCP server), so this must not block or crash dev boot.
 *
 * We require at least one EXPECTED Plane tool (from `LOCAL_PLANE.allowedTools`)
 * in the advertised set before treating the endpoint as a Plane bridge — an
 * empty `tools: []` or some other MCP server answering on the URL must NOT
 * cause us to wire a misleading Plane row.
 */
export async function probePlaneMcpBridge(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      result?: { tools?: Array<{ name?: unknown }> };
    };
    const tools = json.result?.tools;
    if (!Array.isArray(tools)) return null;
    const names = new Set(
      tools.map((t) => (typeof t?.name === "string" ? t.name : "")).filter(Boolean),
    );
    // Must look like a Plane MCP server: at least one of our expected direct
    // tool names present (guards against an empty list or a non-Plane bridge).
    if (!LOCAL_PLANE.allowedTools.some((t) => names.has(t))) return null;
    return names.size;
  } catch {
    return null;
  }
}

/**
 * The Plane auto-setup body (exported for tests; `runDevSetup` wraps it with
 * capability resolution). Wires an enabled `external_mcp_servers` row ONLY
 * when a real Plane MCP bridge (PLANE_MCP_URL) answers `tools/list`; otherwise
 * logs a one-time setup hint and skips the row.
 */
export async function autoSetupLocalPlane(deps: PlaneDevSetupDeps): Promise<ExtensionDevSetupStatus> {
  if (!deps.helpers.probeDockerContainer(LOCAL_PLANE.containerName)) {
    return {
      status: "skipped",
      reason: `${LOCAL_PLANE.containerName} not running (run docker compose --profile plane up -d)`,
    };
  }
  // Plane's proxy + api take a while to settle behind first-boot migrations;
  // use the resilient retry probe rather than a one-shot.
  if (!(await deps.helpers.probeHttpReachableWithRetry(LOCAL_PLANE.serverUrl + LOCAL_PLANE.healthPath))) {
    return {
      status: "skipped",
      reason: `${LOCAL_PLANE.serverUrl}${LOCAL_PLANE.healthPath} not reachable yet (Plane still booting)`,
    };
  }

  // The hint operators need regardless of whether an MCP bridge is configured:
  // Plane has no headless PAT mint, so the agent path needs a one-time sign-up +
  // connect. Logged once per boot (idempotent rows don't re-log this).
  const setupHint =
    `Plane is up at ${LOCAL_PLANE.serverUrl}. ` +
    `One-time setup for agent access: (1) create the first user at ${LOCAL_PLANE.serverUrl}, ` +
    `(2) mint a PAT (Profile → API tokens) and note your workspace slug + a project, ` +
    `(3) paste them into the Plane connector setup page. ` +
    `Plane uses X-API-Key auth (not a Bearer), so there is no headless auto-mint.`;

  // Only wire an enabled MCP row when a REAL Plane MCP bridge answers tools/list.
  // The community compose ships no bridge, so the common path skips the row.
  const mcpUrl = process.env[LOCAL_PLANE.mcpUrlEnvVar]?.trim();
  if (!mcpUrl) {
    deps.log(
      `${setupHint} (No ${LOCAL_PLANE.mcpUrlEnvVar} set — the optional Plane MCP bridge ` +
        `(makeplane/plane-mcp-server) is not part of the community compose; set ${LOCAL_PLANE.mcpUrlEnvVar} ` +
        `to its HTTP api-key endpoint to expose Plane tools to agents.)`,
    );
    return {
      status: "skipped",
      reason: `Plane up; no ${LOCAL_PLANE.mcpUrlEnvVar} configured (no MCP bridge to wire — server-side PM-sync REST port is unaffected)`,
    };
  }

  const toolCount = await probePlaneMcpBridge(mcpUrl);
  if (toolCount === null) {
    deps.log(
      `${setupHint} (${LOCAL_PLANE.mcpUrlEnvVar}=${mcpUrl} did not answer tools/list — not wiring a row ` +
        `that points at an unreachable/non-MCP endpoint.)`,
    );
    return {
      status: "skipped",
      reason: `Plane up; ${LOCAL_PLANE.mcpUrlEnvVar} (${mcpUrl}) did not answer tools/list`,
    };
  }

  const existing = deps.registry.getServerById(LOCAL_PLANE.rowId);
  try {
    deps.registry.upsertServer({
      id: LOCAL_PLANE.rowId,
      label: LOCAL_PLANE.rowLabel,
      serverUrl: mcpUrl,
      // Plane uses X-API-Key custom-header auth, which the registry's Nango
      // Bearer resolution cannot carry — no Nango connection here.
      nangoConnectionId: null,
      scope: "workspace",
      orgId: null,
      userId: null,
      enabled: true,
      // Layer A — Plane is a DIRECT-named-tools MCP server, so constrain the LLM
      // surface by literal tool names. Layer B (`allowedCatalogTools`) is a no-op
      // for Plane (no `execute_tool` dispatcher) and stays null.
      allowedTools: [...LOCAL_PLANE.allowedTools],
      allowedCatalogTools: null,
    });
  } catch (err) {
    return {
      status: "error",
      reason: `upsertExternalMcpServer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  deps.log(setupHint);
  return {
    status: existing ? "already-wired" : "created",
    siteUrl: LOCAL_PLANE.serverUrl,
    detail:
      `row ${LOCAL_PLANE.rowId} ${existing ? "refreshed" : "created"} ` +
      `(MCP bridge ${mcpUrl} advertised ${toolCount} tools; ${LOCAL_PLANE.allowedTools.length} Layer-A tools allowlisted; no bearer — X-API-Key auth)`,
  };
}

// ---------------------------------------------------------------------------
// Capability resolution (structural narrowing; inlined id literal per the
// host-peer value-import ban).
// ---------------------------------------------------------------------------

function isRegistryService(impl: unknown): impl is HostExternalMcpRegistryService {
  const c = impl as Partial<HostExternalMcpRegistryService> | null;
  return (
    !!c &&
    typeof c === "object" &&
    typeof c.getServerById === "function" &&
    typeof c.upsertServer === "function"
  );
}

/** The `cinatra.devSetup` entry point the host's dev-only shell invokes. */
export async function runDevSetup(ctx: ExtensionDevSetupContext): Promise<ExtensionDevSetupStatus> {
  const registryImpl = ctx.capabilities.resolveProviders("@cinatra-ai/host:external-mcp-registry")[0]?.impl ?? null;
  if (!isRegistryService(registryImpl)) {
    return { status: "skipped", reason: "host services unresolved (external-mcp-registry)" };
  }
  return autoSetupLocalPlane({
    registry: registryImpl,
    helpers: ctx.helpers,
    log: ctx.log,
  });
}
