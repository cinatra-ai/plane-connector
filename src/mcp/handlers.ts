import "server-only";

// plane_* provider primitives.
// Parallel to wordpress_status / twenty_status — provider-specific connector-
// state verbs that complement the provider-agnostic PM facade. Projects-list is
// the explicit-mapping helper (the connector stores workspace slug + chosen
// project id; mapping is explicit, no implicit derivation — smoke-proven).

import { getPlaneDeps } from "../deps";
import { planeRest, PlaneRestError, PlaneConfigError } from "../plane-rest-call";

type PlaneStatusResult = {
  reachable: boolean;
  instanceId: string | null;
  workspaceSlug: string | null;
  projectId: string | null;
  message: string;
};

/** Report Plane connector health: is an instance configured, and does a
 *  project-scoped probe authenticate (X-API-Key) + resolve? */
export async function planeStatusHandler(): Promise<PlaneStatusResult> {
  const deps = getPlaneDeps();
  let config;
  try {
    config = await deps.loadInstanceConfig();
  } catch (err) {
    return {
      reachable: false,
      instanceId: null,
      workspaceSlug: null,
      projectId: null,
      message: `plane_status: config read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!config) {
    return {
      reachable: false,
      instanceId: null,
      workspaceSlug: null,
      projectId: null,
      message: "plane_status: no Plane instance configured.",
    };
  }
  // Probe the project scope with a bounded work-item list — a 200 proves the
  // PAT authenticates and the workspace+project resolve.
  try {
    await planeRest("GET", `/work-items/?per_page=1`);
    return {
      reachable: true,
      instanceId: config.instanceId,
      workspaceSlug: config.workspaceSlug,
      projectId: config.projectId,
      message: "plane_status: reachable.",
    };
  } catch (err) {
    const detail =
      err instanceof PlaneRestError
        ? `HTTP ${err.status}`
        : err instanceof PlaneConfigError
          ? "config error"
          : "error";
    return {
      reachable: false,
      instanceId: config.instanceId,
      workspaceSlug: config.workspaceSlug,
      projectId: config.projectId,
      message: `plane_status: probe failed (${detail}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

type PlaneInstance = {
  instanceId: string;
  baseUrl: string;
  workspaceSlug: string;
  projectId: string;
};

/** List the configured Plane connector instance(s). */
export async function planeInstancesListHandler(): Promise<PlaneInstance[]> {
  const deps = getPlaneDeps();
  const config = await deps.loadInstanceConfig();
  if (!config) return [];
  return [
    {
      instanceId: config.instanceId,
      baseUrl: config.baseUrl,
      workspaceSlug: config.workspaceSlug,
      projectId: config.projectId,
    },
  ];
}

type PlaneProject = {
  id: string;
  identifier: string | null;
  name: string | null;
};

/**
 * List the concrete projects in the configured workspace (for the explicit
 * setup-time mapping). GET /api/v1/workspaces/{slug}/projects/ returns
 * id+identifier+name — smoke-proven. The connector stores the chosen project
 * id; mapping is EXPLICIT, never implicitly derived.
 */
export async function planeProjectsListHandler(): Promise<PlaneProject[]> {
  const deps = getPlaneDeps();
  const config = await deps.loadInstanceConfig();
  if (!config) return [];
  const pat = deps.secretsCodec.decryptSecret(config.encryptedPat, config.instanceId);
  const root = config.baseUrl.replace(/\/+$/, "");
  const url = `${root}/api/v1/workspaces/${encodeURIComponent(config.workspaceSlug)}/projects/`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": pat, accept: "application/json" },
  });
  if (!res.ok) {
    throw new PlaneRestError(res.status, `plane projects list -> HTTP ${res.status}`);
  }
  const body = (await res.json()) as
    | { results?: Array<{ id: string; identifier?: string; name?: string }> }
    | Array<{ id: string; identifier?: string; name?: string }>;
  const rows = Array.isArray(body) ? body : (body.results ?? []);
  return rows.map((p) => ({
    id: p.id,
    identifier: p.identifier ?? null,
    name: p.name ?? null,
  }));
}
