# @cinatra-ai/plane-connector

Plane project-management provider for cinatra. A `kind: "connector"` extension that registers a `PmConnector` (provider id `plane`) behind the `pm-provider` capability from its `serverEntry`; the host's PM bridge resolves it via the SDK PM provider registry's external resolver, and the trigger lifecycle mirrors cinatra agent-run triggers into [Plane](https://plane.so) work items (fail-open — a Plane outage never breaks a trigger). Exposes 3 provider-specific MCP primitives (`plane_status`, `plane_instances_list`, `plane_projects_list`).

## Works with

- The host PM bridge (`src/lib/register-pm-providers.ts`) that feeds the SDK PM provider registry's external resolver from the `pm-provider` capability
- Self-hosted Plane CE (`makeplane/plane` community stack, smoke-proven against `v1.3.1`, via the docker stack `docker-compose.yml --profile plane`)

## Capabilities

- ✓ Mirrors cinatra agent-run triggers into Plane work items at trigger configure/delete time; per-run `runId → taskId` mappings stored in their own namespaced connector-config rows (race-free, no shared-map read-modify-write)
- ✓ Auth via `X-API-Key` alone (the sole authenticator; `Authorization: Bearer` is rejected 401) using a user-level Plane PAT (`plane_api_…`, minted via `POST /api/users/api-tokens/`)
- ✓ Encrypted PAT-at-rest via the host `secretsCodec` (AES-256-GCM, instance key) — never plaintext, decrypted in-process only
- ✓ Explicit workspace-slug + project-id mapping; all work-item ops scope to `/workspaces/{slug}/projects/{projectId}/work-items/`; `plane_projects_list` enumerates projects for mapping
- ✓ Day-level `start_date` / `target_date` (strict `YYYY-MM-DD`); never sends `due_date` (Plane REST silently drops it) and asserts the echoed `target_date` after every write, failing loudly on a dropped date
- ✓ Uses `/work-items/` (the forward-looking alias of `/issues/` on Plane CE 1.3.1)
- ✓ Multi-instance support via cinatra's connector-instance surface
