import "server-only";

// Server-side helper for issuing REST calls against a live Plane instance,
// resolving the active instance config (base URL + workspace slug + project id)
// and decrypting the PAT in-process from the host-bound deps slot.
//
// SMOKE-PROVEN auth contract (Plane CE 1.3.1, on-the-wire, cinatra#315):
//   - X-API-Key is the SOLE authenticator. The running api auth middleware
//     reads ONLY request.headers.get("X-Api-Key") (case-insensitive) and never
//     reads x-workspace-slug. The workspace comes from the URL PATH segment.
//   - Matrix: X-API-Key alone -> 200; slug-only -> 401; no headers -> 401;
//     invalid key -> 403 {"detail":"Given API token is not valid"};
//     Authorization: Bearer <pat> -> 401 (NOT accepted).
//   - PAT: user-level token (plane_api_..., len 42), minted via
//     POST /api/users/api-tokens/. Authz is enforced server-side: a valid PAT
//     against a non-member workspace -> 403, against a bogus project id -> 403.
//
// SMOKE-PROVEN date contract:
//   - REST CREATE/PATCH accept start_date / target_date as strict day-level
//     ISO calendar dates (YYYY-MM-DD); a malformed value -> 400.
//   - CRITICAL: REST SILENTLY DROPS due_date (201 but the date vanishes, no
//     error). This connector NEVER sends due_date to REST and ALWAYS asserts the
//     echoed dates after a write (see plane-connector.ts assertEchoedDate).
//
// SMOKE-PROVEN path contract:
//   - /work-items/ and /issues/ are ALIASES on 1.3.1 CE (same endpoint, same
//     shape). /work-items/ is the forward-looking name and is used here.

import { getPlaneDeps, type PlaneInstanceConfig } from "./deps";

export class PlaneRestError extends Error {
  readonly status: number;
  readonly body?: string;
  constructor(status: number, message: string, body?: string) {
    super(message);
    this.name = "PlaneRestError";
    this.status = status;
    this.body = body;
  }
}

export class PlaneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaneConfigError";
  }
}

/** Resolve the active Plane instance config + the decrypted PAT (in-process). */
async function resolveInstance(): Promise<{
  config: PlaneInstanceConfig;
  pat: string;
}> {
  const deps = getPlaneDeps();
  const config = await deps.loadInstanceConfig();
  if (!config) {
    throw new PlaneConfigError(
      "Plane instance not configured — connect a Plane workspace + project via the connector setup page first.",
    );
  }
  let pat: string;
  try {
    // In-process decrypt; the plaintext PAT never leaves this server-side scope
    // other than as the X-API-Key header on the upstream call below.
    pat = deps.secretsCodec.decryptSecret(config.encryptedPat, config.instanceId);
  } catch (err) {
    throw new PlaneConfigError(
      `Plane PAT could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!pat) {
    throw new PlaneConfigError("Plane PAT is empty after decryption.");
  }
  return { config, pat };
}

/** Build the project-scoped REST base for the active instance:
 *  `${baseUrl}/api/v1/workspaces/{slug}/projects/{projectId}`. */
function projectBase(config: PlaneInstanceConfig): string {
  const root = config.baseUrl.replace(/\/+$/, "");
  return `${root}/api/v1/workspaces/${encodeURIComponent(
    config.workspaceSlug,
  )}/projects/${encodeURIComponent(config.projectId)}`;
}

export type PlaneRestMethod = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * Issue a single REST call against the active Plane instance's project scope.
 * `path` is appended to the project base (e.g. "/work-items/", or
 * "/work-items/{id}/"). Returns the parsed JSON body (or null for 204).
 *
 * Auth: attaches `X-API-Key: <pat>` (the SOLE authenticator). Never sends
 * Authorization: Bearer (smoke-proven 401). x-workspace-slug is intentionally
 * NOT sent — the slug is in the path; sending it is harmless but not
 * load-bearing for REST.
 */
export async function planeRest<T = unknown>(
  method: PlaneRestMethod,
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  const { config, pat } = await resolveInstance();
  const url = `${projectBase(config)}${path}`;

  const headers: Record<string, string> = {
    // SOLE authenticator — smoke-proven (lowercase header works too; the api
    // middleware is case-insensitive).
    "x-api-key": pat,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new PlaneRestError(
      0,
      `upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 204) return null;

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // Surface Plane's auth/authz signals precisely (401 missing/invalid-bearer,
    // 403 invalid-key/non-member/bogus-project, 400 malformed date).
    throw new PlaneRestError(
      response.status,
      `Plane REST ${method} ${path} -> HTTP ${response.status}`,
      text.slice(0, 500),
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new PlaneRestError(
      response.status,
      `failed to parse Plane REST response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      text.slice(0, 500),
    );
  }
}
