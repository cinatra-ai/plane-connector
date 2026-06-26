# Plane

Mirrors cinatra agent-run triggers into [Plane](https://plane.so) work items (project management). Configure with a Plane base URL, workspace slug, project id, and a user-level Plane API token (minted via **Profile → API Tokens** in Plane). The PAT is stored encrypted at rest. A Plane outage never breaks a trigger — the connector is fail-open.

**Setup:** The connector requires a Plane base URL (e.g. `http://plane.example.com`), a workspace slug, a project id, and a user-level Plane API token (`plane_api_…`, minted in Plane under **Profile → API Tokens**). These are stored via the host connector-config store with the PAT encrypted at rest.

**Failure modes:** A missing or wrong token returns 401 (no header) or 403 (invalid key). A non-member workspace or unknown project id returns 403. Use `plane_status` (MCP) to probe the connection after setup.

**Development:** `pnpm test` runs the Vitest suite; `node extension-kind-gate.mjs` validates the extension manifest and README locally before publishing.

**Documentation:** the full integration hub lives at [docs.cinatra.ai/integrations/plane](https://docs.cinatra.ai/integrations/plane/) — overview, quick start, settings & permissions, and troubleshooting. The source pages are in this repo under `docs/` and republish on each release tag.

## Works with

- Self-hosted Plane CE (community stack, verified against v1.3.1)

## Capabilities

- ✓ Mirrors cinatra run triggers into Plane work items; day-level start and target dates (YYYY-MM-DD); never sends `due_date` (Plane silently drops it)
- ✓ Idempotent upserts keyed on `runId` — a timed-out first push is found and updated on retry; duplicate reconciliation is best-effort
- ✓ Encrypted PAT at rest (AES-256-GCM, host instance key); decrypted in-process only and sent as `X-API-Key`
- ✓ Read-back via `readTriggerTask`: reads pause/cron/schedule state from Plane; a clean 404 tears down the schedule; any other error fail-opens (trigger fires)
- ✓ MCP primitives: `plane_status` (health probe), `plane_instances_list`, `plane_projects_list`
