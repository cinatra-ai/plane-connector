// Headless prod auto-connect (#40) — the ensurePlaneTokenAttached discipline,
// mirroring twenty-connector's ensureTwentyBearerAttached:
//   - reuse-first (existing valid token => no-op),
//   - rotate ONLY on a definite 401/403,
//   - NEVER mint on a transient/indeterminate validation failure,
//   - validate BEFORE persist,
//   - version-pin the scripted mint with the manual-paste fallback hint,
//   - secret-safe (fingerprints only; token never logged/persisted plaintext).

import { describe, expect, it, vi } from "vitest";

import {
  ensurePlaneTokenAttached,
  validatePlaneToken,
  probePlaneVersion,
  mintPlaneToken,
  fingerprint,
  PlaneMintError,
  SUPPORTED_PLANE_VERSIONS,
  type PlaneProvisionDeps,
  type PlaneAutoConnectOptions,
} from "../plane-provision";
import type { PlaneInstanceConfig } from "../deps";

const BASE = "http://plane.local";
const SLUG = "acme";
const GOOD_VERSION = SUPPORTED_PLANE_VERSIONS[0];

// A fake AES-GCM codec: the envelope carries the plaintext so decrypt is exact,
// and the AAD (instanceId) is asserted round-trip.
function fakeCodec() {
  return {
    encryptSecret: (plaintext: string, aad?: string) => ({ ciphertext: `enc:${plaintext}`, iv: aad ?? "" }),
    decryptSecret: (input: { ciphertext: string; iv: string }, aad?: string) => {
      if ((aad ?? "") !== input.iv) throw new Error("AAD mismatch");
      return input.ciphertext.replace(/^enc:/, "");
    },
  };
}

function makeConfig(overrides: Partial<PlaneInstanceConfig> = {}): PlaneInstanceConfig {
  const codec = fakeCodec();
  const instanceId = overrides.instanceId ?? "plane-default";
  return {
    instanceId,
    baseUrl: BASE,
    workspaceSlug: SLUG,
    projectId: "proj-1",
    encryptedPat: overrides.encryptedPat ?? codec.encryptSecret("plane_api_existing", instanceId),
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type RouteFn = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Build a fetch that dispatches on `METHOD <pathname-suffix>`. The route whose
 *  fragment is the LONGEST endsWith-match of the request pathname wins, so
 *  overlapping paths (`/api/workspaces/` vs `.../projects/`) resolve
 *  unambiguously regardless of declaration order. */
function router(routes: Record<string, RouteFn>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    let best: { frag: string; fn: RouteFn } | null = null;
    for (const [key, fn] of Object.entries(routes)) {
      const [m, ...rest] = key.split(" ");
      const frag = rest.join(" ");
      if (m === method && path.endsWith(frag) && (!best || frag.length > best.frag.length)) best = { frag, fn };
    }
    if (best) return best.fn(url, init ?? {});
    return new Response("no route", { status: 599 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// A full happy-path mint router (CSRF -> admin -> sign-in -> ws -> projects -> token).
function mintRoutes(opts: { token?: string; version?: string; projects?: unknown[] } = {}) {
  const token = opts.token ?? "plane_api_minted";
  return {
    "GET /api/instances/": () => json({ current_version: opts.version ?? GOOD_VERSION }),
    "GET /auth/get-csrf-token/": () =>
      json({ csrf_token: "csrf-123" }, 200, { "set-cookie": "csrftoken=csrf-123; Path=/" }),
    "POST /api/instances/admins/sign-up/": () => json({ ok: true }, 200, { "set-cookie": "sessionid=sess-1; Path=/" }),
    "POST /auth/sign-in/": () => json({ ok: true }, 200, { "set-cookie": "sessionid=sess-2; Path=/" }),
    "POST /api/workspaces/": () => json({ slug: SLUG }, 201),
    "GET /projects/": () => json(opts.projects ?? [{ id: "proj-1", name: "P" }]),
    "POST /api/users/api-tokens/": () => json({ token }),
    // Validation read (X-API-Key): 200 = valid token.
    // NB: shares the "GET /projects/" fragment; ordered after mint list works
    // because the token read also hits /projects/ and returns 200 rows.
  } as Record<string, RouteFn>;
}

function makeDeps(overrides: Partial<PlaneProvisionDeps> = {}): {
  deps: PlaneProvisionDeps;
  saved: PlaneInstanceConfig[];
  logs: string[];
} {
  const saved: PlaneInstanceConfig[] = [];
  const logs: string[] = [];
  const deps: PlaneProvisionDeps = {
    secretsCodec: overrides.secretsCodec ?? fakeCodec(),
    loadInstanceConfig: overrides.loadInstanceConfig ?? (async () => null),
    saveInstanceConfig: overrides.saveInstanceConfig ?? (async (c) => void saved.push(c)),
    httpFetch: overrides.httpFetch,
    log: overrides.log ?? ((m) => logs.push(m)),
  };
  return { deps, saved, logs };
}

const OPTS: PlaneAutoConnectOptions = {
  baseUrl: BASE,
  adminEmail: "admin@acme.test",
  adminPassword: "pw-123",
  workspaceSlug: SLUG,
};

describe("fingerprint", () => {
  it("is a stable 12-hex digest and never the raw secret", async () => {
    const fp = await fingerprint("plane_api_secret");
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fp).not.toContain("secret");
    expect(await fingerprint("plane_api_secret")).toBe(fp);
  });
});

describe("validatePlaneToken", () => {
  it("200 => ok", async () => {
    const { fetch } = router({ "GET /projects/": () => json([]) });
    expect(await validatePlaneToken(fetch, BASE, SLUG, "k")).toBe("ok");
  });
  it("401/403 => unauthorized (definite)", async () => {
    const r1 = router({ "GET /projects/": () => new Response("", { status: 401 }) });
    const r2 = router({ "GET /projects/": () => new Response("", { status: 403 }) });
    expect(await validatePlaneToken(r1.fetch, BASE, SLUG, "k")).toBe("unauthorized");
    expect(await validatePlaneToken(r2.fetch, BASE, SLUG, "k")).toBe("unauthorized");
  });
  it("5xx or network error => unreachable (transient)", async () => {
    const r5 = router({ "GET /projects/": () => new Response("", { status: 503 }) });
    expect(await validatePlaneToken(r5.fetch, BASE, SLUG, "k")).toBe("unreachable");
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await validatePlaneToken(throwing, BASE, SLUG, "k")).toBe("unreachable");
  });
});

describe("probePlaneVersion", () => {
  it("returns current_version (flat shape)", async () => {
    const { fetch } = router({ "GET /api/instances/": () => json({ current_version: "1.3.1" }) });
    expect(await probePlaneVersion(fetch, BASE)).toBe("1.3.1");
  });
  it("returns instance.current_version (nested shape — Plane CE 1.3.1 wire format)", async () => {
    const { fetch } = router({
      "GET /api/instances/": () => json({ config: {}, instance: { current_version: "1.3.1" } }),
    });
    expect(await probePlaneVersion(fetch, BASE)).toBe("1.3.1");
  });
  it("returns null when unreachable or field absent", async () => {
    const miss = router({ "GET /api/instances/": () => json({}) });
    expect(await probePlaneVersion(miss.fetch, BASE)).toBeNull();
    const down = router({ "GET /api/instances/": () => new Response("", { status: 502 }) });
    expect(await probePlaneVersion(down.fetch, BASE)).toBeNull();
  });
});

describe("ensurePlaneTokenAttached — reuse-first", () => {
  it("existing valid token => no-op (reused), never mints, never re-persists", async () => {
    const config = makeConfig();
    const { fetch, calls } = router({ "GET /projects/": () => json([{ id: "proj-1" }]) });
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => config });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("reused");
    expect(r.connected).toBe(true);
    expect(r.minted).toBe(false);
    expect(saved).toHaveLength(0);
    // Only the validation read happened — no CSRF / sign-in / mint calls.
    expect(calls.some((c) => c.includes("/auth/sign-in/"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("idempotent re-run is a no-op (second call with the persisted config)", async () => {
    let stored: PlaneInstanceConfig | null = null;
    const { fetch } = router(mintRoutes());
    const { deps, saved } = makeDeps({
      httpFetch: fetch,
      loadInstanceConfig: async () => stored,
      saveInstanceConfig: async (c) => {
        stored = c;
        saved.push(c);
      },
    });

    const first = await ensurePlaneTokenAttached(deps, OPTS);
    expect(first.status).toBe("connected");
    expect(saved).toHaveLength(1);

    const second = await ensurePlaneTokenAttached(deps, OPTS);
    expect(second.status).toBe("reused");
    expect(second.minted).toBe(false);
    expect(saved).toHaveLength(1); // no second persist
  });
});

describe("ensurePlaneTokenAttached — transient vs definite-401", () => {
  it("existing token, validation UNREACHABLE (5xx) => keeps token, does NOT mint", async () => {
    const config = makeConfig();
    const { fetch, calls } = router({ "GET /projects/": () => new Response("", { status: 503 }) });
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => config });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.connected).toBe(false);
    expect(r.minted).toBe(false);
    expect(r.note).toMatch(/unreachable/);
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("existing token, definite 401 => ROTATE: mints a fresh token + persists", async () => {
    const config = makeConfig();
    let validationCall = 0;
    const routes = mintRoutes({ token: "plane_api_rotated" });
    // First /projects/ hit is the reuse validation (401); later hits are mint
    // list + fresh-token validation (200).
    routes["GET /projects/"] = () => {
      validationCall += 1;
      return validationCall === 1 ? new Response("", { status: 401 }) : json([{ id: "proj-1" }]);
    };
    const { fetch } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => config });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("rotated");
    expect(r.connected).toBe(true);
    expect(r.minted).toBe(true);
    expect(saved).toHaveLength(1);
    // The rotated token is persisted encrypted (never plaintext).
    expect(saved[0].encryptedPat.ciphertext).toBe("enc:plane_api_rotated");
  });

  it("mint TRANSIENT failure (sign-in 5xx) => does NOT persist, keeps existing", async () => {
    const config = makeConfig();
    let validationCall = 0;
    const routes = mintRoutes();
    routes["GET /projects/"] = () => {
      validationCall += 1;
      return validationCall === 1 ? new Response("", { status: 401 }) : json([{ id: "proj-1" }]);
    };
    routes["POST /auth/sign-in/"] = () => new Response("", { status: 502 });
    const { fetch } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => config });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.minted).toBe(false);
    expect(r.note).toMatch(/transient/);
    expect(saved).toHaveLength(0);
  });
});

describe("ensurePlaneTokenAttached — validate before persist", () => {
  it("minted token that FAILS validation is NOT persisted (status error)", async () => {
    let projectsCall = 0;
    const routes = mintRoutes();
    routes["GET /projects/"] = () => {
      projectsCall += 1;
      // First /projects/ = mint's project list (200, has a project); second =
      // post-mint validation read => 403 (token does not authenticate).
      return projectsCall === 1 ? json([{ id: "proj-1" }]) : new Response("", { status: 403 });
    };
    const { fetch } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("error");
    expect(r.connected).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("fresh mint + validation ok => persists encrypted PAT + coordinates, never logs the token", async () => {
    const { fetch } = router(mintRoutes({ token: "plane_api_fresh" }));
    const { deps, saved, logs } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("connected");
    expect(r.connected).toBe(true);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(saved).toHaveLength(1);
    expect(saved[0].workspaceSlug).toBe(SLUG);
    expect(saved[0].projectId).toBe("proj-1");
    expect(saved[0].encryptedPat.ciphertext).toBe("enc:plane_api_fresh");
    // SECRET BOUNDARY: the raw token is never in a log line or the note.
    expect(logs.join("\n")).not.toContain("plane_api_fresh");
    expect(JSON.stringify(r)).not.toContain("plane_api_fresh");
  });
});

describe("ensurePlaneTokenAttached — version pin + fallback", () => {
  it("unsupported version => skip mint, fallback hint (no mint, no persist)", async () => {
    const { fetch, calls } = router({ "GET /api/instances/": () => json({ current_version: "1.4.0" }) });
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.version).toBe("1.4.0");
    expect(r.note).toMatch(/Profile -> API tokens/);
    expect(r.note).toMatch(/SSO/);
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("version unprobeable => skip mint with the fallback hint", async () => {
    const { fetch } = router({ "GET /api/instances/": () => new Response("", { status: 502 }) });
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/could not be probed/);
    expect(saved).toHaveLength(0);
  });

  it("missing admin credentials => skipped with the manual-paste note (no version probe)", async () => {
    const { fetch, calls } = router({ "GET /api/instances/": () => json({ current_version: GOOD_VERSION }) });
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, { ...OPTS, adminPassword: "" });

    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/credentials not provided/);
    expect(saved).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("ensurePlaneTokenAttached — never-mint-without-a-definite-401 (Codex convergence)", () => {
  it("config-store READ failure => skipped, NEVER mints (cannot know if a token exists)", async () => {
    const { fetch, calls } = router(mintRoutes());
    const { deps, saved } = makeDeps({
      httpFetch: fetch,
      loadInstanceConfig: async () => {
        throw new Error("db down");
      },
    });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.minted).toBe(false);
    expect(r.note).toMatch(/config-load-failed/);
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("existing config, UNDECRYPTABLE envelope => skipped, does NOT mint (not a 401)", async () => {
    // AAD (iv) deliberately mismatched vs instanceId => fakeCodec.decrypt throws.
    const config = makeConfig({ encryptedPat: { ciphertext: "enc:x", iv: "WRONG-AAD" } });
    const { fetch, calls } = router(mintRoutes());
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => config });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.minted).toBe(false);
    expect(r.note).toMatch(/undecryptable/);
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("encrypt/persist failure => status error, minted true, connected false, NEVER throws", async () => {
    const { fetch } = router(mintRoutes());
    const { deps } = makeDeps({
      httpFetch: fetch,
      loadInstanceConfig: async () => null,
      saveInstanceConfig: async () => {
        throw new Error("store write failed");
      },
    });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("error");
    expect(r.connected).toBe(false);
    expect(r.minted).toBe(true);
    expect(r.note).toMatch(/persist-failed/);
  });
});

describe("mintPlaneToken — provisioning-path classification (Codex convergence)", () => {
  it("project-list 401 during mint is NOT read as empty (no create/mint) => definite skip", async () => {
    const routes = mintRoutes();
    routes["GET /projects/"] = () => new Response("", { status: 401 });
    const { fetch, calls } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/list projects/);
    expect(saved).toHaveLength(0);
    // never reached project-create or token-mint
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("a pinned projectId absent from the workspace is a DEFINITE failure (no silent fallback)", async () => {
    const routes = mintRoutes({ projects: [{ id: "proj-1" }] });
    const { fetch } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, { ...OPTS, projectId: "proj-does-not-exist" });

    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/pinned projectId not found/);
    expect(saved).toHaveLength(0);
  });

  it("a 429 (rate-limited) mint is classified TRANSIENT", async () => {
    const routes = mintRoutes();
    routes["POST /api/users/api-tokens/"] = () => new Response("", { status: 429 });
    const { fetch } = router(routes);
    await expect(
      mintPlaneToken(fetch, { baseUrl: BASE, adminEmail: "a@b.c", adminPassword: "x", workspaceSlug: SLUG }),
    ).rejects.toMatchObject({ transient: true });
  });

  it("a fatal workspace-create 4xx (422) aborts as definite", async () => {
    const routes = mintRoutes();
    routes["POST /api/workspaces/"] = () => new Response("", { status: 422 });
    const { fetch } = router(routes);
    await expect(
      mintPlaneToken(fetch, { baseUrl: BASE, adminEmail: "a@b.c", adminPassword: "x", workspaceSlug: SLUG }),
    ).rejects.toMatchObject({ transient: false });
  });

  it("a 204 project-list is NOT treated as empty (no create/mint) — definite abort", async () => {
    const routes = mintRoutes();
    routes["GET /projects/"] = () => new Response(null, { status: 204 });
    const { fetch, calls } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("a malformed 200 project-list body is rejected (not read as empty)", async () => {
    const routes = mintRoutes();
    routes["GET /projects/"] = () => json({ unexpected: true });
    const { fetch, calls } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/unexpected response shape/);
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("a non-empty list of malformed rows ([{}]) is rejected — no create/mint", async () => {
    const routes = mintRoutes();
    routes["GET /projects/"] = () => json([{}, { id: 123 }]); // present but no valid string id
    const { fetch, calls } = router(routes);
    const { deps, saved } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(r.note).toMatch(/no valid id/);
    expect(saved).toHaveLength(0);
    expect(calls.some((c) => c.includes("/projects/") && c.startsWith("POST"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/users/api-tokens/"))).toBe(false);
  });

  it("get-csrf 429 is classified TRANSIENT (never falls back to a stale cookie)", async () => {
    const routes = mintRoutes();
    routes["GET /auth/get-csrf-token/"] = () => new Response("", { status: 429 });
    const { fetch } = router(routes);
    await expect(
      mintPlaneToken(fetch, { baseUrl: BASE, adminEmail: "a@b.c", adminPassword: "x", workspaceSlug: SLUG }),
    ).rejects.toMatchObject({ transient: true });
  });

  it("sign-in failure note carries NO upstream error_code (secret-safe fixed label)", async () => {
    const routes = mintRoutes();
    routes["POST /auth/sign-in/"] = () =>
      new Response(null, { status: 302, headers: { location: "http://app/?error_code=plane_api_LEAK" } });
    const { fetch } = router(routes);
    const { deps } = makeDeps({ httpFetch: fetch, loadInstanceConfig: async () => null });

    const r = await ensurePlaneTokenAttached(deps, OPTS);

    expect(r.status).toBe("skipped");
    expect(JSON.stringify(r)).not.toContain("plane_api_LEAK");
  });
});

describe("mintPlaneToken — sign-in failure classification", () => {
  it("definite 401 sign-in throws a non-transient PlaneMintError", async () => {
    const routes = mintRoutes();
    routes["POST /auth/sign-in/"] = () => new Response("", { status: 401 });
    const { fetch } = router(routes);
    await expect(
      mintPlaneToken(fetch, { baseUrl: BASE, adminEmail: "a@b.c", adminPassword: "x", workspaceSlug: SLUG }),
    ).rejects.toMatchObject({ transient: false });
  });

  it("creates a project when the workspace has none", async () => {
    const routes = mintRoutes({ projects: [] });
    routes["POST /projects/"] = () => json({ id: "proj-created" }, 201);
    const { fetch } = router(routes);
    const res = await mintPlaneToken(fetch, {
      baseUrl: BASE,
      adminEmail: "a@b.c",
      adminPassword: "x",
      workspaceSlug: SLUG,
    });
    expect(res.projectId).toBe("proj-created");
  });
});
