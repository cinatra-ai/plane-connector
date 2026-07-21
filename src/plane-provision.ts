import "server-only";

// Headless prod auto-connect for the Plane connector (cinatra-ai/plane-connector#40).
//
// Promotes the proven first-run token-mint into the connector config seam: given
// a Plane base URL + instance-admin credentials, drive Plane CE's CSRF sign-in →
// `POST /api/users/api-tokens/` mint sequence headlessly (no browser), VALIDATE
// the minted token with an authenticated REST read, then persist it through the
// EXISTING `saveInstanceConfig` (`./deps`) — encrypted via `secretsCodec`, plus
// baseUrl / workspaceSlug / projectId. No new storage, no schema change, no host
// contract change.
//
// Mirrors twenty-connector's `ensureTwentyBearerAttached` discipline:
//   - REUSE-FIRST: if a persisted token already authenticates, this is a no-op.
//   - ROTATE ONLY ON A DEFINITE 401/403: a genuinely unauthorized existing token
//     is replaced; a transient/indeterminate validation result (network, 5xx,
//     timeout) NEVER mints — it keeps the existing token to avoid token sprawl.
//   - VALIDATE BEFORE PERSIST: the setup UI treats persisted config as
//     "Connected", so only a token proven with an authenticated REST read is
//     ever written.
//   - SECRET-SAFE LOGGING: only sha256 fingerprints (12 hex) and fixed labels —
//     never a token, password, or cookie value.
//
// VERSION PIN: Plane's `/auth/sign-in/` + `/api/users/api-tokens/` endpoints are
// internal, undocumented, and version-pinned. The scripted mint is validated on
// Plane CE 1.3.1 only; on any other reported version (and inherently for
// cloud / SSO-only / MFA / CAPTCHA / disabled-password instances that defeat a
// scripted sign-in) this skips the mint and returns the manual-paste fallback
// hint. Reuse of an already-valid token is NOT version-gated — a working token
// keeps working regardless of the reported version.

import {
  getPlaneDeps,
  type PlaneInstanceConfig,
  type PlaneSecretsCodec,
} from "./deps";

/** Plane CE versions the scripted headless mint is validated against. The
 *  internal sign-in / api-token endpoints are version-pinned; keep this in
 *  lockstep with the smoke-proven contract (see plane-rest-call.ts). */
export const SUPPORTED_PLANE_VERSIONS = ["1.3.1"] as const;

/** Single-instance connector default (mirrors actions.ts). The instanceId is the
 *  AES-GCM additional-authenticated-data bound at encrypt AND decrypt
 *  (plane-rest-call resolveInstance), so a reused config keeps its own id. */
const DEFAULT_INSTANCE_ID = "plane-default";
const DEFAULT_TOKEN_LABEL = "cinatra-connector";

/** Strip trailing "/" from a URL, in LINEAR time. A regex like `/\/+$/` is a
 *  polynomial-ReDoS hazard on adversarial input (CodeQL js/polynomial-redos), so
 *  scan the tail directly instead. */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return s.slice(0, end);
}

/** Host facilities the provisioning needs — a narrowing of PlaneConnectorHostDeps
 *  plus an injectable fetch (default global) so the flow is unit-testable without
 *  a live Plane. */
export type PlaneProvisionDeps = {
  secretsCodec: PlaneSecretsCodec;
  loadInstanceConfig: () => Promise<PlaneInstanceConfig | null>;
  saveInstanceConfig: (config: PlaneInstanceConfig) => Promise<void>;
  /** Injectable for tests; defaults to the global fetch. */
  httpFetch?: typeof fetch;
  /** Secret-safe logger (fixed labels + fingerprints only). */
  log?: (message: string) => void;
};

export type PlaneAutoConnectOptions = {
  /** Plane base URL, e.g. https://plane.example.com or http://127.0.0.1:3457. */
  baseUrl: string;
  /** Instance-admin email (deployment-provided, e.g. from the secrets vault). */
  adminEmail: string;
  /** Instance-admin password (deployment-provided). */
  adminPassword: string;
  /** Workspace display name (default derived from the slug). */
  workspaceName?: string;
  /** Workspace slug (default derived from the admin email local part). */
  workspaceSlug?: string;
  /** Pin a specific project id; else the first project in the workspace (a
   *  project is created if none exist). */
  projectId?: string;
  /** Connector-config instance id (default plane-default; a reused config keeps
   *  its own). */
  instanceId?: string;
  /** PAT label (default cinatra-connector). */
  tokenLabel?: string;
};

export type PlaneAutoConnectStatus =
  | "reused" // an existing persisted token still authenticates — no-op.
  | "connected" // a fresh token was minted, validated, and persisted.
  | "rotated" // an existing token was definitely-401, replaced + persisted.
  | "skipped" // mint not attempted (env/version/transient) — fallback hint.
  | "error"; // mint attempted but did not yield a validated token.

export type PlaneAutoConnectResult = {
  status: PlaneAutoConnectStatus;
  /** True iff a VALIDATED token is persisted after this call (the UI's
   *  "Connected" condition). */
  connected: boolean;
  /** True iff a fresh token was minted this call. */
  minted: boolean;
  /** Fixed-label note (safe to log/surface). */
  note?: string;
  /** sha256 fingerprint (12 hex) of the active token — safe to log. */
  fingerprint?: string;
  /** The reported Plane version, when probed. */
  version?: string;
};

/** sha256 fingerprint (first 12 hex) — the ONLY form a secret ever takes in a
 *  log line. Mirrors the ops first-run script's `fp()`. */
export async function fingerprint(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/** A definite-vs-transient classification of an authenticated REST validation
 *  read (mirrors twenty's probe trichotomy):
 *   - "ok":           200 — the token authenticates against the workspace.
 *   - "unauthorized": 401/403 — a DEFINITE auth failure (rotate).
 *   - "unreachable":  network error / 5xx / timeout — TRANSIENT (never mint). */
export type PlaneValidation = "ok" | "unauthorized" | "unreachable";

/**
 * Validate a Plane PAT with an authenticated REST read — the SAME `X-API-Key`
 * REST surface the connector uses at runtime (plane-rest-call.ts). A 200 on the
 * workspace projects list proves the token authenticates AND is a member of the
 * target workspace; this is the "validated-before-persist" gate.
 */
export async function validatePlaneToken(
  fetchImpl: typeof fetch,
  baseUrl: string,
  workspaceSlug: string,
  pat: string,
): Promise<PlaneValidation> {
  const root = trimTrailingSlashes(baseUrl);
  const url = `${root}/api/v1/workspaces/${encodeURIComponent(workspaceSlug)}/projects/`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { "x-api-key": pat, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // network error / abort / timeout — TRANSIENT, never a mint trigger.
    return "unreachable";
  }
  if (res.status === 200) return "ok";
  if (res.status === 401 || res.status === 403) return "unauthorized";
  // 5xx / anything else — treat as transient (Plane warming / behind a proxy).
  return "unreachable";
}

/**
 * Probe the reported Plane version via the public `GET /api/instances/` endpoint
 * (answers pre-sign-in). Returns the `current_version` string, or null when the
 * endpoint is unreachable or the field is absent.
 */
export async function probePlaneVersion(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<string | null> {
  const root = trimTrailingSlashes(baseUrl);
  try {
    const res = await fetchImpl(`${root}/api/instances/`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    // Plane CE 1.3.1 nests the version under `instance` (GET /api/instances/
    // returns `{ config, instance: { current_version, ... } }`). Accept the
    // nested shape first, then a flat fallback for resilience across versions.
    const json = (await res.json()) as {
      current_version?: unknown;
      instance?: { current_version?: unknown };
    };
    const nested = json.instance?.current_version;
    if (typeof nested === "string") return nested;
    return typeof json.current_version === "string" ? json.current_version : null;
  } catch {
    return null;
  }
}

function isSupportedVersion(version: string | null): version is string {
  return version !== null && (SUPPORTED_PLANE_VERSIONS as readonly string[]).includes(version);
}

function fallbackHint(version: string | null): string {
  const reported = version ? `Plane version ${version} is not in` : "The Plane version could not be probed against";
  return (
    `${reported} the validated set (${SUPPORTED_PLANE_VERSIONS.join(", ")}) for headless auto-connect. ` +
    `Plane's sign-in / api-token endpoints are internal + version-pinned. ` +
    `Mint a user-level token in Plane (Profile -> API tokens) and paste it, with the workspace slug + a project id, into the connector setup page. ` +
    `Cloud, SSO-only, MFA, CAPTCHA and disabled-password instances also require this manual-paste fallback.`
  );
}

// ---------------------------------------------------------------------------
// The headless CSRF sign-in -> mint sequence (Plane CE 1.3.1). No browser; a
// tiny cookie jar carries the session cookie + csrftoken across calls (Node's
// fetch does NOT persist cookies). Proven flow (endpoints only, never a secret):
//   GET  /auth/get-csrf-token/         -> csrftoken cookie + csrf_token body
//   POST /api/instances/admins/sign-up -> configure the god-mode admin (idem.)
//   POST /auth/sign-in/                -> session cookie (form-encoded)
//   POST /api/workspaces/              -> create the workspace (idempotent)
//   GET  /api/v1/workspaces/{s}/projects/ -> resolve/create the project
//   POST /api/users/api-tokens/        -> mint the PAT (session-authenticated)
// ---------------------------------------------------------------------------

/** Minimal cookie jar: capture Set-Cookie name=value pairs and replay them as a
 *  single Cookie header. Only the name=value is retained (attributes dropped) —
 *  sufficient for Plane's session + CSRF cookies. */
class CookieJar {
  private jar = new Map<string, string>();
  absorb(res: Response): void {
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const raw = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
    for (const line of raw) {
      const first = line.split(";", 1)[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) this.jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  get(name: string): string | undefined {
    return this.jar.get(name);
  }
  header(): string {
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
}

export class PlaneMintError extends Error {
  /** True when the failure is transient (network/5xx) and MUST NOT overwrite an
   *  existing token; false for a definite/config failure. */
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = "PlaneMintError";
    this.transient = transient;
  }
}

type MintResult = { pat: string; workspaceSlug: string; projectId: string };

async function jarFetch(
  fetchImpl: typeof fetch,
  jar: CookieJar,
  url: string,
  init: RequestInit & { csrf?: string },
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) headers.set("cookie", cookie);
  if (init.csrf) headers.set("x-csrftoken", init.csrf);
  headers.set("referer", url);
  let res: Response;
  try {
    // redirect: "manual" is LOAD-BEARING. Plane's session-auth endpoints
    // (/api/instances/admins/sign-up/, /auth/sign-in/) answer with a 302 to the
    // web-app URL — success or failure is encoded in the Location's `error_code`.
    // A server-to-server client MUST NOT follow that redirect: the app URL may be
    // unreachable from the provisioning host, and the session cookie + outcome
    // ride the 302 itself. Node's undici exposes status + Location + Set-Cookie on
    // a manual redirect (type "basic"), so we read the outcome directly.
    res = await fetchImpl(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30000) });
  } catch {
    // SECRET BOUNDARY: a FIXED label only — a raw fetch/undici error message can
    // echo the request (password body, Cookie header) into a surfaced note.
    throw new PlaneMintError("upstream fetch failed (network/timeout)", true);
  }
  jar.absorb(res);
  return res;
}

/** Plane encodes an auth outcome in the 302 Location's `error_code` query param
 *  (success = no error_code). Returns the error_code, or null. */
function redirectErrorCode(res: Response, root: string): string | null {
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    return new URL(loc, root).searchParams.get("error_code");
  } catch {
    return null;
  }
}

/** Is an HTTP status transient (retryable — never a definite failure)? 5xx plus
 *  the standard retryable 4xx (408 timeout, 425 too-early, 429 rate-limited). */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** Throw a correctly-classified PlaneMintError for a non-ok provisioning
 *  response (transient vs definite), with a FIXED, secret-free label. */
function throwHttp(label: string, status: number): never {
  throw new PlaneMintError(`${label} -> HTTP ${status}`, isTransientStatus(status));
}

async function getCsrf(fetchImpl: typeof fetch, jar: CookieJar, root: string): Promise<string> {
  const res = await jarFetch(fetchImpl, jar, `${root}/auth/get-csrf-token/`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  // Require a genuine 200 before trusting the body or the csrftoken cookie — a
  // 408/425/429/4xx must NOT silently fall back to a previously-retained cookie
  // and continue provisioning (classify + throw instead).
  if (res.status !== 200) throwHttp("get-csrf", res.status);
  const token = await res
    .json()
    .then((j: { csrf_token?: unknown }) => (typeof j.csrf_token === "string" ? j.csrf_token : null))
    .catch(() => null);
  const csrf = token ?? jar.get("csrftoken") ?? null;
  if (!csrf) throw new PlaneMintError("no csrf token available", true);
  return csrf;
}

/** Drive the headless CSRF sign-in + mint. Throws PlaneMintError (transient flag
 *  set) on failure so the caller can honor the never-mint-on-transient rule. */
export async function mintPlaneToken(
  fetchImpl: typeof fetch,
  opts: Required<Pick<PlaneAutoConnectOptions, "baseUrl" | "adminEmail" | "adminPassword">> &
    Pick<PlaneAutoConnectOptions, "workspaceName" | "workspaceSlug" | "projectId" | "tokenLabel">,
): Promise<MintResult> {
  const root = trimTrailingSlashes(opts.baseUrl);
  const slug = (opts.workspaceSlug || opts.adminEmail.split("@")[0] || "workspace")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const wsName = opts.workspaceName || slug;
  const jar = new CookieJar();

  // 1. Configure the god-mode instance admin (idempotent — a second run returns
  //    a definite 4xx "already configured", which we tolerate and move on).
  let csrf = await getCsrf(fetchImpl, jar, root);
  const signUp = await jarFetch(fetchImpl, jar, `${root}/api/instances/admins/sign-up/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      email: opts.adminEmail,
      password: opts.adminPassword,
      first_name: "Cinatra",
      last_name: "Admin",
      company_name: wsName,
      is_telemetry_enabled: "0",
    }).toString(),
    csrf,
  });
  // The ONLY benign outcomes are a 2xx or a 302 (success, OR the idempotent
  // ADMIN_ALREADY_EXIST re-run — Plane encodes both as a 302 to the app URL).
  // Any other 4xx/5xx is a real fault; sign-in below is the ultimate gate.
  if (!signUp.ok && !(signUp.status >= 300 && signUp.status < 400)) throwHttp("admin sign-up", signUp.status);

  // 2. Sign in (populates the session cookie). Plane answers 302; the outcome is
  //    in the Location's error_code (success = none). A definite auth failure
  //    (bad creds / disabled password / SSO-only) must NOT be treated as
  //    transient — it means the manual-paste fallback applies.
  csrf = await getCsrf(fetchImpl, jar, root);
  const signIn = await jarFetch(fetchImpl, jar, `${root}/auth/sign-in/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ email: opts.adminEmail, password: opts.adminPassword }).toString(),
    csrf,
  });
  if (isTransientStatus(signIn.status)) throw new PlaneMintError(`sign-in -> HTTP ${signIn.status}`, true);
  // The Location `error_code` is only a PRESENCE signal (failed sign-in). It is
  // NEVER interpolated into a surfaced message — it is upstream-controlled and
  // could in principle carry a secret; the label stays fixed (safe HTTP status
  // only). SECRET BOUNDARY.
  const signInFailed = signIn.status >= 400 || redirectErrorCode(signIn, root) !== null;
  if (signInFailed)
    throw new PlaneMintError(
      `sign-in failed (HTTP ${signIn.status}; credentials / SSO / disabled-password)`,
      false,
    );

  // 3. Create the workspace. The ONLY tolerated non-2xx is a 400/409 conflict
  //    (the slug already exists — idempotent). That the workspace truly exists is
  //    re-proven by resolveProject's list, which must return 200. Any other 4xx
  //    (bad input) is a definite fault; 408/425/429/5xx are transient.
  csrf = await getCsrf(fetchImpl, jar, root);
  const wsRes = await jarFetch(fetchImpl, jar, `${root}/api/workspaces/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: wsName, slug, organization_size: "1-10" }),
    csrf,
  });
  if (!wsRes.ok && wsRes.status !== 400 && wsRes.status !== 409) throwHttp("create workspace", wsRes.status);

  // 4. Resolve the project: honor a pinned projectId when present in the list,
  //    else take the first; create one if the workspace has none.
  let projectId = await resolveProject(fetchImpl, jar, root, slug, opts.projectId, wsName);

  // 5. Mint the user PAT (session-authenticated).
  csrf = await getCsrf(fetchImpl, jar, root);
  const tokRes = await jarFetch(fetchImpl, jar, `${root}/api/users/api-tokens/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ label: opts.tokenLabel || DEFAULT_TOKEN_LABEL }),
    csrf,
  });
  if (!tokRes.ok) throwHttp("mint token", tokRes.status);
  const pat = await tokRes
    .json()
    .then((j: { token?: unknown }) => (typeof j.token === "string" ? j.token : ""))
    .catch(() => "");
  if (!pat) throw new PlaneMintError("mint token -> no token in response", false);

  return { pat, workspaceSlug: slug, projectId };
}

async function resolveProject(
  fetchImpl: typeof fetch,
  jar: CookieJar,
  root: string,
  slug: string,
  pinned: string | undefined,
  wsName: string,
): Promise<string> {
  // Session-authenticated APP API (NOT the `/api/v1/` REST surface, which needs
  // X-API-Key and 401s under a session cookie). Both list + create go through the
  // app API here; the minted PAT is what later drives the `/api/v1/` REST path.
  const listRes = await jarFetch(fetchImpl, jar, `${root}/api/workspaces/${encodeURIComponent(slug)}/projects/`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  // ONLY a 200 with a well-formed array body is authoritative. Anything else — a
  // 401/403/404/429/5xx, a 204, or a malformed/unrecognized 200 body — must NOT
  // be read as "no projects" (that would wrongly trigger a create + mint). Only a
  // genuinely empty, valid list may fall through to project creation below.
  if (listRes.status !== 200) throwHttp("list projects", listRes.status);
  const body = (await listRes.json().catch(() => null)) as unknown;
  const rows: Array<{ id?: unknown }> | null = Array.isArray(body)
    ? (body as Array<{ id?: unknown }>)
    : Array.isArray((body as { results?: unknown })?.results)
      ? ((body as { results: Array<{ id?: unknown }> }).results)
      : null;
  if (rows === null) throw new PlaneMintError("list projects -> unexpected response shape", false);
  const ids = rows.map((r) => (typeof r.id === "string" ? r.id : "")).filter(Boolean);
  if (pinned) {
    // A pinned project that is absent is a DEFINITE misconfiguration — never
    // silently connect a different project.
    if (ids.includes(pinned)) return pinned;
    throw new PlaneMintError(`pinned projectId not found in workspace ${slug}`, false);
  }
  if (ids.length > 0) return ids[0];
  // A NON-EMPTY list that yielded no valid string id is a malformed response —
  // do NOT create (that would mint against a project that may already exist);
  // creation is reserved for a GENUINELY empty list.
  if (rows.length > 0) throw new PlaneMintError("list projects -> rows present but no valid id", false);

  // None exist — create one (identifier is required + upper-cased by Plane CE).
  const csrf = await getCsrf(fetchImpl, jar, root);
  const identifier = (slug.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "CIN").toUpperCase();
  const createRes = await jarFetch(fetchImpl, jar, `${root}/api/workspaces/${encodeURIComponent(slug)}/projects/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ name: `${wsName} project`, identifier }),
    csrf,
  });
  if (!createRes.ok) throwHttp("create project", createRes.status);
  const created = (await createRes.json().catch(() => ({}))) as { id?: unknown };
  if (typeof created.id !== "string" || !created.id)
    throw new PlaneMintError("create project -> no id in response", false);
  return created.id;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Ensure the Plane connector has a persisted, VALIDATED token — fully headless.
 * Reuse-first; rotate only on a definite 401/403; never mint on a transient
 * failure; version-gate the scripted mint; validate before persist. Never throws
 * (soft-fail with a fixed-label note).
 */
export async function ensurePlaneTokenAttached(
  deps: PlaneProvisionDeps,
  opts: PlaneAutoConnectOptions,
): Promise<PlaneAutoConnectResult> {
  const fetchImpl = deps.httpFetch ?? fetch;
  const log = deps.log ?? (() => {});

  // A config-store READ failure is transient — we cannot know whether a token
  // already exists, so minting could duplicate. Fail closed: skip, never mint.
  let existing: PlaneInstanceConfig | null;
  try {
    existing = await deps.loadInstanceConfig();
  } catch {
    log("plane auto-connect: config load failed — not minting (transient)");
    return {
      status: "skipped",
      connected: false,
      minted: false,
      note: "config-load-failed (could not read existing config; not minting)",
    };
  }

  // 1. REUSE-FIRST — validate any existing token against ITS OWN coordinates.
  //    The ONLY trigger that falls through to a mint/rotate is a DEFINITE
  //    validation `unauthorized` (401/403). Every other outcome with an existing
  //    config present — transient validation, an undecryptable envelope, an empty
  //    plaintext — KEEPS the config and skips (never mints a duplicate), exactly
  //    as twenty-connector's ensureTwentyBearerAttached does.
  let rotating = false;
  if (existing) {
    let pat: string | null = null;
    let decryptFailed = false;
    try {
      pat = deps.secretsCodec.decryptSecret(existing.encryptedPat, existing.instanceId);
    } catch {
      decryptFailed = true; // undecryptable envelope (e.g. rotated instance key).
    }
    if (decryptFailed || !pat) {
      // Not a 401 — do NOT rotate/mint. Keep the config; the operator clears it
      // to force a fresh mint. This prevents token sprawl on a non-auth fault.
      log("plane auto-connect: existing token undecryptable/empty — kept config, not minting");
      return {
        status: "skipped",
        connected: false,
        minted: false,
        note: "credential-undecryptable (kept existing config; not minting — clear the config to force a re-mint)",
      };
    }
    const probe = await validatePlaneToken(fetchImpl, existing.baseUrl, existing.workspaceSlug, pat);
    if (probe === "ok") {
      const fp = await fingerprint(pat);
      log(`plane auto-connect: existing token valid (fp=${fp}) — no-op`);
      return { status: "reused", connected: true, minted: false, note: "existing token valid", fingerprint: fp };
    }
    if (probe === "unreachable") {
      // TRANSIENT — keep the token, DO NOT mint (avoids a duplicate on a blip).
      log("plane auto-connect: existing token validation unreachable — kept existing token, not minting");
      return {
        status: "skipped",
        connected: false,
        minted: false,
        note: "validation-unreachable (kept existing token; not minting)",
      };
    }
    // probe === "unauthorized" → DEFINITE 401/403 → the ONLY rotate trigger.
    rotating = true;
    log("plane auto-connect: existing token unauthorized (401/403) — rotating");
  }

  // 2. Admin credentials are required to mint.
  if (!opts.baseUrl || !opts.adminEmail || !opts.adminPassword) {
    return {
      status: "skipped",
      connected: false,
      minted: false,
      note:
        "auto-connect credentials not provided (baseUrl + adminEmail + adminPassword). " +
        "Use the manual-paste path in the connector setup page.",
    };
  }

  // 3. VERSION PIN — gate the scripted mint (reuse above is NOT version-gated).
  const version = await probePlaneVersion(fetchImpl, opts.baseUrl);
  if (!isSupportedVersion(version)) {
    const note = fallbackHint(version);
    log(`plane auto-connect: version-gated skip (reported=${version ?? "unknown"})`);
    return { status: "skipped", connected: false, minted: false, note, version: version ?? undefined };
  }

  // 4. Mint headlessly. A transient failure NEVER overwrites an existing token.
  let minted: MintResult;
  try {
    minted = await mintPlaneToken(fetchImpl, {
      baseUrl: opts.baseUrl,
      adminEmail: opts.adminEmail,
      adminPassword: opts.adminPassword,
      workspaceName: opts.workspaceName,
      workspaceSlug: opts.workspaceSlug,
      projectId: opts.projectId,
      tokenLabel: opts.tokenLabel,
    });
  } catch (err) {
    const transient = err instanceof PlaneMintError ? err.transient : true;
    // SECRET BOUNDARY: fixed label + the (secret-free) mint-error message only.
    const label = err instanceof PlaneMintError ? err.message : "mint failed";
    log(`plane auto-connect: mint ${transient ? "transient" : "definite"} failure — not persisting`);
    return {
      status: "skipped",
      connected: false,
      minted: false,
      note: transient
        ? `mint transient failure (${label}); kept any existing token, not persisting`
        : `mint failed (${label}); manual-paste fallback applies`,
      version,
    };
  }

  // 5. VALIDATE BEFORE PERSIST — an authenticated REST read against the freshly
  //    minted token. Only a proven token is written (the UI's Connected gate).
  const probe = await validatePlaneToken(fetchImpl, opts.baseUrl, minted.workspaceSlug, minted.pat);
  if (probe !== "ok") {
    // The token WAS created on Plane but does not authenticate — do not persist.
    // (Plane has no headless token-delete; the unvalidated token is left dormant
    // rather than trusted. `minted:true` records that a token was created so the
    // caller/operator knows a dormant token exists.)
    log(`plane auto-connect: minted token failed validation (${probe}) — NOT persisting`);
    return {
      status: "error",
      connected: false,
      minted: true,
      note: `minted token failed validation (${probe}); not persisting (a dormant Plane token was created)`,
      version,
    };
  }

  // 6. Persist via the EXISTING saveInstanceConfig (encrypted PAT + coordinates).
  //    NEVER-THROW: an encryption or saveInstanceConfig failure must degrade to a
  //    soft-fail status (honoring the docstring), not reject — with a FIXED label
  //    (SECRET BOUNDARY: a raw codec/store error could echo the plaintext PAT).
  const instanceId = existing?.instanceId ?? opts.instanceId ?? DEFAULT_INSTANCE_ID;
  try {
    const encryptedPat = deps.secretsCodec.encryptSecret(minted.pat, instanceId);
    const config: PlaneInstanceConfig = {
      instanceId,
      baseUrl: trimTrailingSlashes(opts.baseUrl),
      workspaceSlug: minted.workspaceSlug,
      projectId: minted.projectId,
      encryptedPat,
      updatedAt: new Date().toISOString(),
    };
    await deps.saveInstanceConfig(config);
  } catch {
    log("plane auto-connect: encrypt/persist failed — NOT connected");
    return {
      status: "error",
      connected: false,
      minted: true,
      note: "encrypt-or-persist-failed (validated token not stored)",
      version,
    };
  }

  const fp = await fingerprint(minted.pat);
  log(`plane auto-connect: token ${rotating ? "rotated" : "minted"} + validated + persisted (fp=${fp})`);
  return {
    status: rotating ? "rotated" : "connected",
    connected: true,
    minted: true,
    fingerprint: fp,
    version,
  };
}

// ---------------------------------------------------------------------------
// Env-driven headless entry (the prod invocation seam). Reads deployment-provided
// admin credentials from the environment and resolves the host-bound deps slot —
// the in-connector replacement for the ops first-run script. No host-contract
// change: the deployment invokes this; the connector owns the mint logic.
// ---------------------------------------------------------------------------

export async function runPlaneAutoConnect(
  env: Record<string, string | undefined> = process.env,
  overrides?: Partial<PlaneProvisionDeps>,
): Promise<PlaneAutoConnectResult> {
  const baseUrl = (env.PLANE_URL ?? "").trim();
  const adminEmail = (env.PLANE_ADMIN_EMAIL ?? "").trim();
  const adminPassword = env.PLANE_ADMIN_PASSWORD ?? "";
  if (!baseUrl || !adminEmail || !adminPassword) {
    return {
      status: "skipped",
      connected: false,
      minted: false,
      note:
        "auto-connect env not set (PLANE_URL + PLANE_ADMIN_EMAIL + PLANE_ADMIN_PASSWORD). " +
        "The manual-paste path in the connector setup page remains the fallback.",
    };
  }
  const hostDeps = getPlaneDeps();
  const deps: PlaneProvisionDeps = {
    secretsCodec: overrides?.secretsCodec ?? hostDeps.secretsCodec,
    loadInstanceConfig: overrides?.loadInstanceConfig ?? hostDeps.loadInstanceConfig,
    saveInstanceConfig: overrides?.saveInstanceConfig ?? hostDeps.saveInstanceConfig,
    httpFetch: overrides?.httpFetch,
    log: overrides?.log,
  };
  return ensurePlaneTokenAttached(deps, {
    baseUrl,
    adminEmail,
    adminPassword,
    workspaceName: env.PLANE_WORKSPACE_NAME?.trim() || undefined,
    workspaceSlug: env.PLANE_WORKSPACE_SLUG?.trim() || undefined,
    projectId: env.PLANE_PROJECT_ID?.trim() || undefined,
  });
}
