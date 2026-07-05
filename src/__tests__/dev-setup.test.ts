// Connector-owned dev-setup hook — Plane row-wiring discipline
// (cinatra#976 relocation): wire an enabled `external_mcp_servers` row ONLY
// when a real Plane MCP bridge answers `tools/list`; never mint/attach a
// bearer (Plane uses X-API-Key, not Nango Bearer — no Nango dependency here
// at all, unlike the Twenty hook).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { autoSetupLocalPlane, probePlaneMcpBridge, LOCAL_PLANE, type PlaneDevSetupDeps } from "../dev-setup";

function makeDeps(): { deps: PlaneDevSetupDeps; upsertServer: ReturnType<typeof vi.fn>; getServerById: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
  const upsertServer = vi.fn();
  const getServerById = vi.fn(() => null);
  const log = vi.fn();
  const deps: PlaneDevSetupDeps = {
    registry: { getServerById, upsertServer },
    helpers: {
      probeDockerContainer: vi.fn(() => true),
      probeHttp: vi.fn(() => true),
      probeHttpAnswered: vi.fn(() => true),
      probeHttpReachableWithRetry: vi.fn(async () => true),
      dockerExecCapture: vi.fn(() => ({ code: 0, out: "" })),
      isLocalhostUrl: vi.fn(() => true),
      trimTrailingSlashes: (s: string) => s,
    },
    log,
  };
  return { deps, upsertServer, getServerById, log };
}

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("probePlaneMcpBridge", () => {
  it("returns the tool count when the bridge answers tools/list with an expected tool", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ result: { tools: [{ name: "list_projects" }, { name: "create_work_item" }] } }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const count = await probePlaneMcpBridge("http://localhost:9999/mcp");
    expect(count).toBe(2);
  });

  it("returns null when no expected Plane tool is present (guards against a non-Plane MCP server)", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ result: { tools: [{ name: "unrelated_tool" }] } }), { status: 200 }),
    ) as unknown as typeof fetch;

    const count = await probePlaneMcpBridge("http://localhost:9999/mcp");
    expect(count).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBeNull();
  });

  it("returns null on a network error", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await probePlaneMcpBridge("http://localhost:9999/mcp")).toBeNull();
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

  it("PLANE_MCP_URL set but bridge does not answer tools/list → skipped, no row written", async () => {
    process.env[LOCAL_PLANE.mcpUrlEnvVar] = "http://localhost:9999/mcp";
    global.fetch = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const { deps, upsertServer } = makeDeps();

    const r = await autoSetupLocalPlane(deps);

    expect(r.status).toBe("skipped");
    expect(upsertServer).not.toHaveBeenCalled();
  });

  it("bridge answers tools/list → wires an enabled row, Layer-A allowlist, no bearer", async () => {
    process.env[LOCAL_PLANE.mcpUrlEnvVar] = "http://localhost:9999/mcp";
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ result: { tools: [{ name: "list_projects" }] } }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { deps, upsertServer } = makeDeps();

    const r = await autoSetupLocalPlane(deps);

    expect(r.status).toBe("created");
    expect(upsertServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: LOCAL_PLANE.rowId,
        nangoConnectionId: null,
        allowedTools: [...LOCAL_PLANE.allowedTools],
        allowedCatalogTools: null,
      }),
    );
  });
});
