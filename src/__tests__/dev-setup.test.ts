// Connector-owned dev-setup hook — Plane row-wiring discipline
// (cinatra#976 relocation; cinatra#1238 demo auto-connect, owner ruling
// 2026-07-23 (groganz)): wire an enabled `external_mcp_servers` row ONLY when a
// real Plane MCP bridge answers the MCP Streamable-HTTP handshake with a Plane
// tool; never mint/attach a Nango bearer (Plane uses X-API-Key — the row's auth
// is null and the bridge holds the PAT server-side).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { autoConnectPlaneConfig, autoSetupLocalPlane, probePlaneMcpBridge, LOCAL_PLANE, type PlaneDevSetupDeps } from "../dev-setup";

function makeDeps(): { deps: PlaneDevSetupDeps; upsertServer: ReturnType<typeof vi.fn>; getServerById: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  const upsertServer = vi.fn();
  const getServerById = vi.fn(() => null);
  const log = vi.fn();
  const deps: PlaneDevSetupDeps = {
    registry: { getServerById, upsertServer },
    helpers: {
      probeDockerContainer: vi.fn(() => true),
      probeHttp: vi.fn(() => true),
      probeHttpReachableWithRetry: vi.fn(async () => true),
      dockerExecCapture: vi.fn(() => ({ code: 0, out: "" })),
      isLocalhostUrl: vi.fn(() => true),
      trimTrailingSlashes: (s: string) => s,
    },
    log,
  };
  return { deps, upsertServer, getServerById, log };
}

/** Read the JSON-RPC method off a mocked fetch request init. */
function methodOf(init: RequestInit | undefined): string {
  try {
    return (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method ?? "";
  } catch {
    return "";
  }
}

/**
 * A fake MCP Streamable-HTTP bridge: answers `initialize` (pins a session id),
 * swallows `notifications/initialized` with a 202, and returns `tools/list`. The
 * body encoding is JSON by default, or SSE (`text/event-stream`) when `sse` is
 * set — the probe must handle both.
 */
function mockMcpBridge(tools: string[], opts: { sse?: boolean; sessionId?: string } = {}): typeof fetch {
  const sessionId = opts.sessionId ?? "sess-abc";
  const encode = (envelope: unknown): { body: string; contentType: string } =>
    opts.sse
      ? { body: `event: message\ndata: ${JSON.stringify(envelope)}\n\n`, contentType: "text/event-stream" }
      : { body: JSON.stringify(envelope), contentType: "application/json" };
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const method = methodOf(init);
    if (method === "initialize") {
      const { body, contentType } = encode({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "plane", version: "1" } },
      });
      return new Response(body, { status: 200, headers: { "content-type": contentType, "mcp-session-id": sessionId } });
    }
    if (method === "notifications/initialized") {
      return new Response("", { status: 202 });
    }
    if (method === "tools/list") {
      const { body, contentType } = encode({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: tools.map((name) => ({ name })) },
      });
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    }
    return new Response("", { status: 400 });
  }) as unknown as typeof fetch;
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("probePlaneMcpBridge (MCP Streamable-HTTP handshake)", () => {
  it("returns the tool count when the bridge answers the handshake with an expected Plane tool", async () => {
    global.fetch = mockMcpBridge(["list_projects", "create_work_item"]);
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBe(2);
  });

  it("handles an SSE (text/event-stream) response body", async () => {
    global.fetch = mockMcpBridge(["list_projects", "list_work_items", "update_work_item"], { sse: true });
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBe(3);
  });

  it("id-matches: an SSE tools/list stream with an unrelated envelope before the real one picks the id-2 response", async () => {
    // The tools/list response frame is preceded by an unrelated (wrong-id)
    // result envelope; the probe must select the id:2 tools/list envelope.
    global.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = methodOf(init);
      if (method === "initialize") {
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } })}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" },
        });
      }
      if (method === "notifications/initialized") return new Response("", { status: 202 });
      if (method === "tools/list") {
        const noise = JSON.stringify({ jsonrpc: "2.0", id: 99, result: { unrelated: true } });
        const real = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "list_projects" }, { name: "create_work_item" }] } });
        return new Response(`event: message\ndata: ${noise}\n\nevent: message\ndata: ${real}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("", { status: 400 });
    }) as unknown as typeof fetch;
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBe(2);
  });

  it("carries the pinned Mcp-Session-Id from initialize onto tools/list", async () => {
    const fetchMock = mockMcpBridge(["list_projects"], { sessionId: "sess-xyz" });
    global.fetch = fetchMock;
    await probePlaneMcpBridge("http://localhost:9999/mcp");
    // The tools/list call (3rd fetch) must echo the session id initialize pinned.
    const calls = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const toolsListCall = calls.find(([, init]) => methodOf(init as RequestInit) === "tools/list");
    expect(toolsListCall).toBeDefined();
    const headers = (toolsListCall?.[1] as RequestInit)?.headers as Record<string, string>;
    expect(headers["Mcp-Session-Id"]).toBe("sess-xyz");
  });

  it("returns null when no expected Plane tool is present (guards against a non-Plane MCP server)", async () => {
    global.fetch = mockMcpBridge(["unrelated_tool"]);
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBeNull();
  });

  it("returns null when initialize fails (not an MCP server)", async () => {
    global.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBeNull();
  });

  it("returns null when initialize 200s but carries no result envelope", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBeNull();
  });

  it("returns null on a network error", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBeNull();
  });
});

describe("autoConnectPlaneConfig (facet 1 — headless demo auto-connect, never-throw)", () => {
  beforeEach(() => {
    delete process.env.PLANE_URL;
    delete process.env.PLANE_ADMIN_EMAIL;
    delete process.env.PLANE_ADMIN_PASSWORD;
  });

  it("plain dev boot (no admin creds in env) → soft no-op, logs the skip, never throws", async () => {
    const log = vi.fn();
    await expect(autoConnectPlaneConfig(log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/auto-connect: skipped/));
  });

  it("admin creds present but host deps unbound → caught, logs the skip, never throws", async () => {
    // With admin creds set, runPlaneAutoConnect proceeds to resolve host deps
    // (getPlaneDeps), which THROWS in this bare test process (no register()).
    // autoConnectPlaneConfig must swallow that so a dev boot never rejects.
    process.env.PLANE_URL = "http://localhost:3400";
    process.env.PLANE_ADMIN_EMAIL = "admin@plane.localhost";
    process.env.PLANE_ADMIN_PASSWORD = "dev-only-not-a-real-secret";
    const log = vi.fn();
    await expect(autoConnectPlaneConfig(log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/host deps not bound/));
  });
});

describe("autoSetupLocalPlane", () => {
  beforeEach(() => {
    delete process.env[LOCAL_PLANE.mcpUrlEnvVar];
  });

  it("container down → skipped with the compose profile hint", async () => {
    const { deps } = makeDeps();
    (deps.helpers.probeDockerContainer as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    const r = await autoSetupLocalPlane(deps);

    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("expected skipped");
    expect(r.reason).toMatch(/--profile plane/);
  });

  it("no PLANE_MCP_URL configured → skipped, no row written, one-time hint logged", async () => {
    const { deps, upsertServer, log } = makeDeps();

    const r = await autoSetupLocalPlane(deps);

    expect(r.status).toBe("skipped");
    expect(upsertServer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/No PLANE_MCP_URL set/));
  });

  it("PLANE_MCP_URL set but bridge does not answer the handshake → skipped, no row written", async () => {
    process.env[LOCAL_PLANE.mcpUrlEnvVar] = "http://localhost:9999/mcp";
    global.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const { deps, upsertServer } = makeDeps();

    const r = await autoSetupLocalPlane(deps);

    expect(r.status).toBe("skipped");
    expect(upsertServer).not.toHaveBeenCalled();
  });

  it("bridge answers the handshake → wires an enabled streamable-http row, Layer-A allowlist, no bearer", async () => {
    process.env[LOCAL_PLANE.mcpUrlEnvVar] = "http://localhost:9999/mcp";
    global.fetch = mockMcpBridge(["list_projects"]);
    const { deps, upsertServer } = makeDeps();

    const r = await autoSetupLocalPlane(deps);

    expect(r.status).toBe("created");
    expect(upsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: LOCAL_PLANE.rowId,
        nangoConnectionId: null,
        transport: "streamable-http",
        allowedTools: [...LOCAL_PLANE.allowedTools],
        allowedCatalogTools: null,
      }),
    );
  });
});
