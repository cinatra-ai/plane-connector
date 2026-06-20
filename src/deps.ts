import "server-only";

// Plane provider deps surface.
//
// Provider connectors declare the host facilities they consume here (per the
// provider-connector contract). The host wires concrete implementations at
// boot; the provider package depends only on the types declared here.
//
// What Plane needs from the host (narrower than twenty — Plane is REST, not an
// external-MCP row):
//   - secretsCodec: AES-256-GCM encrypt/decrypt over the host instance key, to
//     store the Plane PAT encrypted-at-rest (NEVER plaintext). Mirrors the host
//     `@cinatra-ai/host:secrets-codec` capability that wordpress/drupal/twenty
//     use for their API keys.
//   - configStore: read/write the connector_config row holding the encrypted
//     PAT + the chosen workspace slug + project id + base URL, and the
//     runId→taskId mapping rows.
//
// The deps slot is anchored on `globalThis` via a namespaced+versioned Symbol
// so the boot-time registration and the runtime callers — which live in
// SEPARATELY-COMPILED Next.js bundles — resolve the SAME slot. (Same reason as
// the twenty/crm/github/linkedin deps slots.)

/** AES-256-GCM secret codec over the host instance key. Storage stays in the
 *  connector's own config rows — this is a CODEC, not a store. Mirrors the
 *  host `HostSecretsCodecService` shape. */
export type PlaneSecretsCodec = {
  encryptSecret(plaintext: string, aad?: string): { ciphertext: string; iv: string };
  decryptSecret(input: { ciphertext: string; iv: string }, aad?: string): string;
};

/** The connector's stored configuration for a single Plane instance. The PAT is
 *  NEVER stored in plaintext — `encryptedPat` holds the secretsCodec envelope. */
export type PlaneInstanceConfig = {
  /** Connector instance id (connector_config row key). */
  instanceId: string;
  /** Plane base URL (e.g. https://plane.example.com or http://127.0.0.1:3400).
   *  All REST calls are scoped under `${baseUrl}/api/v1/workspaces/{slug}/`. */
  baseUrl: string;
  /** Workspace slug the connector is bound to (URL path segment — the SOLE
   *  workspace selector for REST; smoke-proven the slug comes from the path,
   *  not a header). */
  workspaceSlug: string;
  /** Chosen project id all work-item ops scope to
   *  (`/workspaces/{slug}/projects/{projectId}/work-items/`). */
  projectId: string;
  /** secretsCodec envelope of the Plane PAT (`plane_api_...`, user-level, minted
   *  via POST /api/users/api-tokens/). Decrypted in-process ONLY; never crosses
   *  a wire boundary other than the X-API-Key header on the upstream call. */
  encryptedPat: { ciphertext: string; iv: string };
  /** ISO timestamp the instance config was last written. */
  updatedAt: string;
};

export interface PlaneConnectorHostDeps {
  /** The host secrets codec (encrypt/decrypt the PAT). */
  secretsCodec: PlaneSecretsCodec;
  /** Read the active Plane instance config, or null when none is configured. */
  loadInstanceConfig: () => Promise<PlaneInstanceConfig | null>;
  /** Persist (upsert) the Plane instance config (encrypted PAT included). */
  saveInstanceConfig: (config: PlaneInstanceConfig) => Promise<void>;
  /** Read the mapped Plane work-item id for a cinatra run id (null = unmapped). */
  loadRunTaskId: (runId: string) => Promise<string | null>;
  /** Upsert the runId→taskId mapping. */
  saveRunTaskId: (runId: string, taskId: string) => Promise<void>;
  /** Delete the runId→taskId mapping (idempotent). */
  deleteRunTaskId: (runId: string) => Promise<void>;
}

const PLANE_DEPS_KEY = Symbol.for("@cinatra-ai/plane-connector:host-deps/v1");
type DepsHolder = { [k: symbol]: PlaneConnectorHostDeps | null | undefined };
const _holder = globalThis as unknown as DepsHolder;

export function registerPlaneConnector(deps: PlaneConnectorHostDeps): void {
  _holder[PLANE_DEPS_KEY] = deps;
}

export function getPlaneDeps(): PlaneConnectorHostDeps {
  const deps = _holder[PLANE_DEPS_KEY];
  if (!deps) {
    throw new Error(
      "@cinatra-ai/plane-connector: host runtime deps not registered. " +
        "Call registerPlaneConnector(deps) at boot.",
    );
  }
  return deps;
}

/** @internal test-only. */
export function _resetPlaneDepsForTests(): void {
  _holder[PLANE_DEPS_KEY] = null;
}
