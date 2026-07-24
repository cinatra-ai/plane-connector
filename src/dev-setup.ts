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
//     Twenty's `workspace:generate-api-key`) — the mint is driven over the
//     network by the connector's own proven CSRF sign-in sequence
//     (`./plane-provision`, plane-connector#40/#41; version-gated to Plane CE
//     1.3.1, reuse-first, validate-before-persist, never-throw).
//
// DEMO AUTO-CONNECT (cinatra#1238; owner ruling 2026-07-23 (groganz) — Plane
// posture is AUTOMATIC, the manual-PAT carve-out is withdrawn). When the demo
// bring-up has placed instance-admin credentials in the environment
// (`PLANE_URL` + `PLANE_ADMIN_EMAIL` + `PLANE_ADMIN_PASSWORD`), this hook first
// runs `runPlaneAutoConnect` to headlessly mint + validate + persist a Plane
// connector config, so the connector shows "Connected" with NO manual paste.
// A plain dev boot with those vars unset is a NO-OP for that step (the
// manual-paste path in the setup page remains) and the row-wiring below is
// unchanged. The two facets are independent: the persisted config drives the
// connector's REST PM-sync + "Connected" state; the row below exposes the MCP
// bridge tools to agents when `PLANE_MCP_URL` answers.
//
// Idempotent. Soft-fails (returns a status object) — never throws. Secret-safe:
// no credentials are sent or logged (only a static JSON-RPC envelope; the
// auto-connect step logs only sha256 fingerprints + fixed labels).
//
// SDK imports are TYPE-ONLY (host-peer value-import ban); the host services
// resolve at call time through the capability port on the hook context.

import type {
  ExtensionDevSetupContext,
  ExtensionDevSetupStatus,
  HostExternalMcpRegistryService,
} from "@cinatra-ai/sdk-extensions";
// Value-import of the connector's OWN proven headless auto-connect (a sibling
// module in THIS package — NOT a host peer, so the host-peer value-import ban
// does not apply). `runPlaneAutoConnect` is reuse-first, version-gated to Plane
// CE 1.3.1, validate-before-persist, and never-throws.
import { runPlaneAutoConnect } from "./plane-provision";

export const LOCAL_PLANE = {
  containerName: "cinatra-plane-proxy-1",
  // The single loopback-published port of the whole Plane stack (proxy -> api).
  serverUrl: "http://localhost:3400",
  // Liveness endpoint served by the api behind the proxy (answers pre-sign-up).
  healthPath: "/api/instances/",
  rowId: "plane-workspace",
  rowLabel: "Plane (local dev)",
  // Optional separate MCP bridge: the official Plane MCP server
  // (makeplane/plane-mcp-server) in single-tenant stdio mode (holds the PAT +
  // workspace slug from env) fronted by mcp-proxy so it serves MCP
  // Streamable-HTTP on loopback. Not part of the community compose — the demo
  // `--profile plane-mcp` brings it up and sets this URL; wired only when it
  // answers the MCP handshake with a real Plane tool.
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

// ---------------------------------------------------------------------------
// MCP Streamable-HTTP handshake (the wire the real bridge speaks).
//
// The demo bridge is the OFFICIAL Plane MCP server (makeplane/plane-mcp-server)
// run in single-tenant `stdio` mode — which holds the PAT + workspace slug from
// its env — fronted by `mcp-proxy` so it serves the MODERN MCP Streamable-HTTP
// transport on loopback (cinatra#1238; owner ruling 2026-07-23 (groganz)). That
// transport is NOT a bare `POST {tools/list}` → JSON: it negotiates JSON *or*
// `text/event-stream`, pins an optional `Mcp-Session-Id`, and requires an
// `initialize` handshake first. The host's RUNTIME external-MCP client already
// speaks this via `@modelcontextprotocol/sdk` (row `transport: "streamable-http"`),
// so this probe must recognize the SAME wire — otherwise it would refuse to wire
// a row the runtime can in fact call. Bounded + soft (never throws).
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = "2025-06-18";
const PROBE_TIMEOUT_MS = 6000;

type JsonRpcEnvelope = { id?: unknown; result?: unknown; error?: unknown };

/** Does this envelope answer the request `expectedId`? An envelope with no `id`
 *  (or when we did not ask for a specific one) is accepted leniently. */
function envelopeMatches(obj: JsonRpcEnvelope, expectedId: number | undefined): boolean {
  if (!obj || !("result" in obj || "error" in obj)) return false;
  if (expectedId === undefined) return true;
  // Match the request id when the server echoes one; accept an id-less envelope
  // (some servers omit it) rather than false-negative.
  return obj.id === undefined || obj.id === expectedId;
}

/** Parse a Streamable-HTTP MCP response body that is EITHER `application/json`
 *  OR `text/event-stream` (SSE). For SSE, the JSON-RPC envelope rides the
 *  `data:` line(s) of a `message` event. Returns the envelope answering
 *  `expectedId` (the request's JSON-RPC id) — id-matched so a multiplexed stream
 *  can't select an unrelated envelope — or null. */
async function readMcpBody(res: Response, expectedId: number | undefined): Promise<JsonRpcEnvelope | null> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    let lenientFallback: JsonRpcEnvelope | null = null;
    for (const frame of text.split(/\n\n+/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        const obj = JSON.parse(data) as JsonRpcEnvelope;
        if (!obj || !("result" in obj || "error" in obj)) continue;
        if (envelopeMatches(obj, expectedId) && (expectedId === undefined || obj.id === expectedId)) {
          return obj; // exact id match (or no id expected) — the strongest pick.
        }
        // Remember an id-less result/error as a lenient fallback if no exact
        // id match is found in a later frame.
        if (lenientFallback === null && envelopeMatches(obj, expectedId)) lenientFallback = obj;
      } catch {
        /* not JSON — keep scanning frames */
      }
    }
    return lenientFallback;
  }
  // application/json, or a body without a content-type (best-effort parse). A
  // single JSON body is the one response to this POST.
  try {
    const obj = JSON.parse(text) as JsonRpcEnvelope;
    return envelopeMatches(obj, expectedId) ? obj : null;
  } catch {
    return null;
  }
}

/** One JSON-RPC POST over MCP Streamable-HTTP. Carries + refreshes the session
 *  id the server may pin. `expectedId` is the request's JSON-RPC id (undefined
 *  for a notification). `ok` is the transport-level success; `envelope` is the
 *  id-matched JSON-RPC (null for a notification's empty 202 body or an
 *  unparseable/unmatched response). */
async function mcpPost(
  url: string,
  body: unknown,
  expectedId: number | undefined,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<{ ok: boolean; envelope: JsonRpcEnvelope | null; sessionId: string | undefined }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Advertise BOTH so the server may answer with JSON or SSE per its default.
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const nextSession = res.headers.get("mcp-session-id") ?? sessionId;
  if (!res.ok) return { ok: false, envelope: null, sessionId: nextSession };
  return { ok: true, envelope: await readMcpBody(res, expectedId), sessionId: nextSession };
}

/**
 * Probe a Plane MCP bridge URL by driving the real MCP Streamable-HTTP handshake
 * (`initialize` → `notifications/initialized` → `tools/list`). Returns the
 * advertised tool-name count on success, or null when the URL is unset /
 * unreachable / not an MCP server / not a PLANE MCP server. Bounded
 * (PROBE_TIMEOUT_MS) + soft (never throws): a missing bridge is a COMMON case,
 * so this must not block or crash dev boot.
 *
 * We require at least one EXPECTED Plane tool (from `LOCAL_PLANE.allowedTools`)
 * in the advertised set before treating the endpoint as a Plane bridge — an
 * empty `tools: []` or some other MCP server answering on the URL must NOT
 * cause us to wire a misleading Plane row.
 */
export async function probePlaneMcpBridge(url: string): Promise<number | null> {
  try {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);

    // 1. initialize — the mandatory MCP handshake; pins the session id (if any).
    const init = await mcpPost(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "cinatra-plane-devsetup", version: "1.0.0" },
        },
      },
      1,
      undefined,
      signal,
    );
    const initResult = init.envelope && "result" in init.envelope ? init.envelope.result : null;
    if (!init.ok || initResult == null) return null;

    // 2. notifications/initialized — spec-required before further requests; a
    //    fire-and-forget notification (no id/result). Its outcome is irrelevant.
    await mcpPost(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      undefined,
      init.sessionId,
      signal,
    ).catch(() => undefined);

    // 3. tools/list — the actual capability probe.
    const list = await mcpPost(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      2,
      init.sessionId,
      signal,
    );
    const listResult =
      list.envelope && "result" in list.envelope
        ? (list.envelope.result as { tools?: Array<{ name?: unknown }> } | null)
        : null;
    const tools = listResult?.tools;
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

  // The hint operators need when the demo auto-connect was NOT driven (a plain
  // dev boot with no instance-admin credentials in the env): the connector-
  // config auto-connect above is a no-op then, so the agent path still needs a
  // one-time sign-up + PAT paste. Logged once per boot (idempotent rows don't
  // re-log this). In a demo install the auto-connect already persisted a
  // validated config, so this is purely the manual-fallback breadcrumb.
  const setupHint =
    `Plane is up at ${LOCAL_PLANE.serverUrl}. ` +
    `If it is not already Connected (a demo install auto-connects it), one-time manual setup: ` +
    `(1) create the first user at ${LOCAL_PLANE.serverUrl}, ` +
    `(2) mint a PAT (Profile → API tokens) and note your workspace slug + a project, ` +
    `(3) paste them into the Plane connector setup page. ` +
    `Plane uses X-API-Key auth (not a Bearer) — the headless mint is driven over ` +
    `Plane's CSRF sign-in by the connector's auto-connect when the demo provides admin creds.`;

  // Only wire an enabled MCP row when a REAL Plane MCP bridge answers tools/list.
  // The community compose ships no bridge, so the common path skips the row.
  const mcpUrl = process.env[LOCAL_PLANE.mcpUrlEnvVar]?.trim();
  if (!mcpUrl) {
    deps.log(
      `${setupHint} (No ${LOCAL_PLANE.mcpUrlEnvVar} set — the optional Plane MCP bridge ` +
        `(makeplane/plane-mcp-server via mcp-proxy) is not part of the community compose; ` +
        `bring it up with \`docker compose --profile plane-mcp up -d\` and set ${LOCAL_PLANE.mcpUrlEnvVar} ` +
        `to its Streamable-HTTP endpoint to expose Plane tools to agents. A demo install does this for you.)`,
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
      // The demo bridge (mcp-proxy over the stdio Plane MCP server) speaks the
      // modern MCP Streamable-HTTP transport; pin it on the row so the host's
      // runtime external-MCP client dials it correctly (never inferred from the
      // URL — llm-providers S2, #1713). `upsertServer` takes an untyped input
      // bag, so this passes through to the host record's `transport` column.
      transport: "streamable-http",
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

/**
 * Demo auto-connect (cinatra#1238; owner ruling 2026-07-23 (groganz)). When the
 * demo bring-up has provisioned instance-admin credentials into the environment
 * (`PLANE_URL` + `PLANE_ADMIN_EMAIL` + `PLANE_ADMIN_PASSWORD`), headlessly mint,
 * validate, and persist a Plane connector config through the connector's OWN
 * proven `runPlaneAutoConnect` (#40/#41) so the connector shows "Connected" with
 * no manual paste. A plain dev boot (those vars unset) is a soft no-op.
 *
 * NEVER-THROW boundary: `runPlaneAutoConnect` is already soft-fail, but its
 * host-deps resolution (`getPlaneDeps()`) can throw when the connector's deps
 * slot is not yet bound; catch that so the dev hook can never reject. SECRET
 * BOUNDARY: only the fixed status + sha256 fingerprint (never a token) is logged.
 */
export async function autoConnectPlaneConfig(log: (message: string) => void): Promise<void> {
  try {
    const result = await runPlaneAutoConnect(process.env);
    // `note`/`fingerprint`/`version` are all secret-free (fixed labels + a
    // 12-hex sha256 fingerprint) — safe to surface.
    const fp = result.fingerprint ? ` fp=${result.fingerprint}` : "";
    log(`Plane connector auto-connect: ${result.status}${fp}${result.note ? ` — ${result.note}` : ""}`);
  } catch {
    // Deps slot not yet bound, or any other unexpected throw — a plain dev boot
    // with no demo credentials is the common case and must never break dev boot.
    log("Plane connector auto-connect: skipped (host deps not bound or unavailable)");
  }
}

/** The `cinatra.devSetup` entry point the host's dev-only shell invokes. */
export async function runDevSetup(ctx: ExtensionDevSetupContext): Promise<ExtensionDevSetupStatus> {
  // Facet 1 (owner ruling — AUTOMATIC connection): headlessly ensure a
  // persisted, validated connector config first, so the connector reports
  // "Connected" independently of whether an MCP bridge is present. Soft — never
  // affects the row-wiring status below.
  await autoConnectPlaneConfig(ctx.log);

  // Facet 2: wire the external_mcp_servers row when a real Plane MCP bridge
  // answers `tools/list` at PLANE_MCP_URL (exposes Plane tools to agents).
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
